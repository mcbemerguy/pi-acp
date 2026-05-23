import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/pi-tools.js'
import { toToolCallLocations, toToolKind } from './translate/tool-metadata.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { isWorkflowCommandPrompt, parseWorkflowCommandPrompt, WorkflowEventMonitor } from './workflow-events.js'
import {
  handleExtensionUiRequest,
  isDialogExtensionUiMethod,
  normalizeExtensionUiRequest,
  PI_EXTENSION_UI_EVENT_METHOD
} from './extension-ui.js'
import { PI_USAGE_UPDATE_METHOD, piUsageTelemetryFromPiSessionStats, usageUpdateFromPiSessionStats } from './usage.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type ToolMetadata = {
  title: string
  kind: ToolKind
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function toolCallName(toolCall: unknown): string | undefined {
  const value = toolCall as {
    name?: unknown
    toolName?: unknown
    function?: { name?: unknown }
  } | null

  const name = value?.name ?? value?.toolName ?? value?.function?.name
  return typeof name === 'string' && name.trim() ? name : undefined
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.dispose()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private currentAgentMessageId: string | null = null

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private currentToolMetadata = new Map<string, ToolMetadata>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false
  private completingTurn = false
  private sawAgentActivity = false
  private promptAckFallbackTimer: NodeJS.Timeout | null = null
  private currentWorkflowMonitor: WorkflowEventMonitor | null = null

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string }>()

  private lastSend: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  dispose(): void {
    this.currentWorkflowMonitor?.dispose()
    this.currentWorkflowMonitor = null
    this.proc.dispose?.()
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  publishUsageUpdateFromStats(stats: unknown): void {
    const update = usageUpdateFromPiSessionStats(stats)
    if (update) this.emit(update)
  }

  publishPiUsageTelemetryFromStats(stats: unknown, state?: unknown): void {
    const usage = piUsageTelemetryFromPiSessionStats(stats, state)
    if (usage) this.emitCustomNotification(PI_USAGE_UPDATE_METHOD, { sessionId: this.sessionId, usage })
  }

  private enqueueSend(send: () => Promise<void>): void {
    this.lastSend = this.lastSend.then(send).catch(() => {})
  }

  private emit(update: SessionUpdate): void {
    this.enqueueSend(() =>
      this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    )
  }

  private emitCustomNotification(method: string, params: Record<string, unknown>): void {
    this.enqueueSend(() => this.conn.extNotification(method, params))
  }

  private async flushEmits(): Promise<void> {
    await this.lastSend
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.completingTurn = false
    this.sawAgentActivity = false
    if (this.promptAckFallbackTimer) {
      clearTimeout(this.promptAckFallbackTimer)
      this.promptAckFallbackTimer = null
    }
    this.currentAgentMessageId = crypto.randomUUID()
    const workflowTarget = parseWorkflowCommandPrompt(t.message)
    this.currentWorkflowMonitor = isWorkflowCommandPrompt(t.message)
      ? new WorkflowEventMonitor(this.cwd, update => this.emit(update), {
          target: workflowTarget ? { ...workflowTarget, parentSessionId: this.sessionId } : null
        })
      : null
    this.currentWorkflowMonitor?.start()

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    this.proc
      .prompt(t.message, t.images)
      .then(() => {
        this.promptAckFallbackTimer = setTimeout(() => {
          this.promptAckFallbackTimer = null
          if (!this.inAgentLoop && !this.sawAgentActivity) {
            this.completeTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
          }
        }, 100)
      })
      .catch(err => {
        const authErr = maybeAuthRequiredError(err)
        if (authErr) this.completeTurn('error', { reject: authErr, proceedQueue: false })
        else this.completeTurn(this.cancelRequested ? 'cancelled' : 'error', { proceedQueue: false })
      })
  }

  private completeTurn(reason: StopReason, opts: { reject?: unknown; proceedQueue?: boolean } = {}): void {
    if (!this.pendingTurn || this.completingTurn) return
    this.completingTurn = true
    const pending = this.pendingTurn
    const monitor = this.currentWorkflowMonitor
    this.currentWorkflowMonitor = null

    void (async () => {
      if (monitor) await monitor.stopAfterPromptResolution()
      await this.flushEmits()

      if (opts.reject) pending.reject(opts.reject)
      else pending.resolve(reason)

      if (this.promptAckFallbackTimer) {
        clearTimeout(this.promptAckFallbackTimer)
        this.promptAckFallbackTimer = null
      }

      this.pendingTurn = null
      this.inAgentLoop = false
      this.completingTurn = false
      this.sawAgentActivity = false
      this.currentAgentMessageId = null

      const proceedQueue = opts.proceedQueue ?? true
      const next = proceedQueue ? this.turnQueue.shift() : undefined
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next)
      } else {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      }
    })()
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'extension_ui_request': {
        this.handleExtensionUiRequest(ev)
        break
      }

      case 'message_update': {
        this.sawAgentActivity = true
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            ...(this.currentAgentMessageId ? { messageId: this.currentAgentMessageId } : {}),
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = toolCallName(toolCall)

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (!existingStatus) {
              if (toolName) {
                const metadata = { title: toolName, kind: toToolKind(toolName) }
                this.currentToolCalls.set(toolCallId, 'pending')
                this.currentToolMetadata.set(toolCallId, metadata)
                this.emit({
                  sessionUpdate: 'tool_call',
                  toolCallId,
                  title: metadata.title,
                  kind: metadata.kind,
                  status,
                  locations,
                  rawInput
                })
              }
            } else {
              const metadata = toolName
                ? { title: toolName, kind: toToolKind(toolName) }
                : this.currentToolMetadata.get(toolCallId)
              if (metadata) this.currentToolMetadata.set(toolCallId, metadata)
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        this.sawAgentActivity = true
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? args.oldText : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // Ignore snapshot failures; we'll fall back to plain text output.
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        const metadata = { title: toolName, kind: toToolKind(toolName) }
        this.currentToolMetadata.set(toolCallId, metadata)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: metadata.title,
            kind: metadata.kind,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: metadata.title,
            kind: metadata.kind,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        const text = toolResultToText(partial)
        const metadata = this.currentToolMetadata.get(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content.
        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        const metadata = this.currentToolMetadata.get(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: result
        })

        this.currentToolCalls.delete(toolCallId)
        this.currentToolMetadata.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.sawAgentActivity = true
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        this.completeTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
        break
      }

      default:
        break
    }
  }

  private handleExtensionUiRequest(ev: PiRpcEvent): void {
    const method = String((ev as any).method ?? '')
    const id = typeof (ev as any).id === 'string' ? ((ev as any).id as string) : undefined
    const payload = normalizeExtensionUiRequest(this.sessionId, ev)

    if (payload) this.emitCustomNotification(PI_EXTENSION_UI_EVENT_METHOD, payload)

    if (id && shouldRespondToExtensionUiRequest(method)) {
      void handleExtensionUiRequest({ event: ev, conn: this.conn, proc: this.proc }).catch(() => {
        this.proc.sendExtensionUiResponse(id, method === 'confirm' ? { confirmed: false } : { cancelled: true })
      })
    }
  }
}

function shouldRespondToExtensionUiRequest(method: string): boolean {
  return (
    isDialogExtensionUiMethod(method) ||
    !['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(method)
  )
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}
