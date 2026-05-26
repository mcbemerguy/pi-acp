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
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { SessionStore } from './session-store.js'
import {
  TOOL_PRESENTATION_LIMITS,
  presentationDiagnostic,
  safePresentationValue,
  toolResultToPresentationText,
  type PresentationSource
} from './translate/pi-tools.js'
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

const CANCEL_ABORT_TIMEOUT_MS = 3_500
const CANCEL_DRAIN_TIMEOUT_MS = 2_000

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

export type OutboundPressureSnapshot = {
  enqueued: number
  completed: number
  failed: number
  pending: number
  maxPending: number
  coalesced: number
  diagnostics: number
}

type OutboundQueueItem = {
  kind: 'sessionUpdate' | 'extNotification'
  update?: SessionUpdate
  method?: string
  params?: Record<string, unknown>
  resolve?: () => void
  reject?: (err: unknown) => void
}

const OUTBOUND_BACKLOG_DIAGNOSTIC_PENDING = 256

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
      fileCommands: params.fileCommands ?? [],
      sessionFile
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
      fileCommands: params.fileCommands ?? [],
      sessionFile: null
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
  private readonly cancelAbortTimeoutMs: number
  private readonly sessionFile: string | null

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
  private completingWorkflowMonitor: WorkflowEventMonitor | null = null
  private completionReasonOverride: StopReason | null = null
  private drainingCancelledTurn = false
  private cancelDrainTimer: NodeJS.Timeout | null = null

  private editSnapshots = new Map<string, { path: string; oldText?: string; skippedReason?: string }>()

  private outboundQueue: OutboundQueueItem[] = []
  private sendingOutbound = false
  private drainingOutbound = false
  private outboundDrainWaiters: Array<() => void> = []
  private outboundDiagnosticQueued = false
  private outboundPressure: OutboundPressureSnapshot = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    maxPending: 0,
    coalesced: 0,
    diagnostics: 0
  }

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    cancelAbortTimeoutMs?: number
    sessionFile?: string | null
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.cancelAbortTimeoutMs = opts.cancelAbortTimeoutMs ?? CANCEL_ABORT_TIMEOUT_MS
    this.sessionFile = opts.sessionFile ?? null

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  dispose(): void {
    this.currentWorkflowMonitor?.dispose()
    this.currentWorkflowMonitor = null
    this.completingWorkflowMonitor?.dispose()
    this.completingWorkflowMonitor = null
    if (this.cancelDrainTimer) {
      clearTimeout(this.cancelDrainTimer)
      this.cancelDrainTimer = null
    }
    this.drainingCancelledTurn = false
    this.proc.dispose?.()
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn || this.drainingCancelledTurn) {
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
    console.error(
      `[pi-acp] session/cancel received sessionId=${this.sessionId} pendingTurn=${Boolean(this.pendingTurn)} queuedTurns=${this.turnQueue.length}`
    )
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

    if (!this.pendingTurn) {
      await this.proc.abort().catch(error => {
        console.error(
          `[pi-acp] pi RPC abort ignored with no pending turn: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      return
    }

    try {
      await this.withTimeout(this.proc.abort(), this.cancelAbortTimeoutMs, 'pi abort')
      if (!this.interruptCompletingTurn('cancelled', { drainPiEvents: true })) {
        this.completeTurn('cancelled', { drainPiEvents: true })
      }
    } catch (error) {
      console.error(
        `[pi-acp] pi RPC abort timed out or failed; killing subprocess sessionId=${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Pi did not acknowledge cancellation; restarting the ACP subprocess.' }
      })
      if (!this.interruptCompletingTurn('cancelled')) this.completeTurn('cancelled')
      this.proc.dispose('SIGKILL')
      console.error(`[pi-acp] pi subprocess killed after abort failure sessionId=${this.sessionId}`)
    }
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

  getOutboundPressureSnapshot(): OutboundPressureSnapshot {
    return { ...this.outboundPressure }
  }

  private enqueueOutbound(item: OutboundQueueItem): void {
    this.outboundPressure.enqueued += 1
    if (this.coalesceOutbound(item)) {
      this.outboundPressure.coalesced += 1
      this.updateOutboundPendingPressure()
      return
    }

    this.outboundQueue.push(item)
    this.updateOutboundPendingPressure()
    this.queueOutboundDiagnosticIfNeeded()
    this.drainOutboundQueue()
  }

  private coalesceOutbound(item: OutboundQueueItem): boolean {
    if (item.kind !== 'sessionUpdate' || !item.update || item.resolve || item.reject) return false
    const previous = this.outboundQueue[this.outboundQueue.length - 1]
    if (!previous || previous.kind !== 'sessionUpdate' || !previous.update) return false

    if (mergeTextChunkUpdate(previous.update, item.update)) return true
    if (replaceRoutinePresentationUpdate(previous, item)) return true

    return false
  }

  private queueOutboundDiagnosticIfNeeded(): void {
    const pending = this.currentOutboundPending()
    if (pending < OUTBOUND_BACKLOG_DIAGNOSTIC_PENDING || this.outboundDiagnosticQueued) return

    this.outboundDiagnosticQueued = true
    this.outboundPressure.diagnostics += 1
    this.outboundPressure.enqueued += 1
    this.outboundQueue.push({
      kind: 'sessionUpdate',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `ACP outbound presentation is backlogged (${pending} updates pending); routine text/status updates may be coalesced after ingestion.`
        } satisfies ContentBlock
      }
    })
    this.updateOutboundPendingPressure()
  }

  private drainOutboundQueue(): void {
    if (this.drainingOutbound) return
    this.drainingOutbound = true
    void (async () => {
      while (this.outboundQueue.length) {
        const item = this.outboundQueue.shift()
        if (!item) continue
        this.sendingOutbound = true
        this.updateOutboundPendingPressure()
        try {
          if (item.kind === 'sessionUpdate') {
            await this.conn.sessionUpdate({ sessionId: this.sessionId, update: item.update as SessionUpdate })
          } else {
            await this.conn.extNotification(String(item.method), item.params ?? {})
          }
          this.outboundPressure.completed += 1
          item.resolve?.()
        } catch (err) {
          this.outboundPressure.failed += 1
          item.reject?.(err)
        } finally {
          this.sendingOutbound = false
          this.updateOutboundPendingPressure()
        }
      }
      this.drainingOutbound = false
      this.outboundDiagnosticQueued = false
      this.resolveOutboundDrainWaiters()
      if (this.outboundQueue.length) this.drainOutboundQueue()
    })()
  }

  private currentOutboundPending(): number {
    return this.outboundQueue.length + (this.sendingOutbound ? 1 : 0)
  }

  private updateOutboundPendingPressure(): void {
    const pending = this.currentOutboundPending()
    this.outboundPressure.pending = pending
    this.outboundPressure.maxPending = Math.max(this.outboundPressure.maxPending, pending)
  }

  private resolveOutboundDrainWaiters(): void {
    if (this.currentOutboundPending() !== 0) return
    const waiters = this.outboundDrainWaiters.splice(0, this.outboundDrainWaiters.length)
    for (const resolve of waiters) resolve()
  }

  private emit(update: SessionUpdate): void {
    this.enqueueOutbound({ kind: 'sessionUpdate', update })
  }

  private emitCustomNotification(method: string, params: Record<string, unknown>): void {
    this.enqueueOutbound({ kind: 'extNotification', method, params })
  }

  private async flushEmits(): Promise<void> {
    if (this.currentOutboundPending() === 0) return
    await new Promise<void>(resolve => this.outboundDrainWaiters.push(resolve))
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.completingTurn = false
    this.completingWorkflowMonitor = null
    this.completionReasonOverride = null
    this.sawAgentActivity = false
    if (this.promptAckFallbackTimer) {
      clearTimeout(this.promptAckFallbackTimer)
      this.promptAckFallbackTimer = null
    }
    this.stopCancelledTurnDrain()
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
        if (authErr) {
          this.completeTurn('error', { reject: authErr, proceedQueue: false })
          return
        }
        if (this.cancelRequested) {
          this.completeTurn('cancelled', { proceedQueue: false })
          return
        }
        const message = `Pi prompt failed: ${err instanceof Error ? err.message : String(err)}`
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message } satisfies ContentBlock
        })
        this.completeTurn('error', { reject: RequestError.internalError({}, message), proceedQueue: false })
      })
  }

  private interruptCompletingTurn(reason: StopReason, opts: { drainPiEvents?: boolean } = {}): boolean {
    if (!this.pendingTurn || !this.completingTurn) return false
    this.completionReasonOverride = reason
    if (opts.drainPiEvents) this.startCancelledTurnDrain()
    this.currentWorkflowMonitor?.dispose()
    this.currentWorkflowMonitor = null
    this.completingWorkflowMonitor?.dispose()
    this.completingWorkflowMonitor = null
    return true
  }

  private completeTurn(
    reason: StopReason,
    opts: { reject?: unknown; proceedQueue?: boolean; drainPiEvents?: boolean } = {}
  ): void {
    if (!this.pendingTurn || this.completingTurn) return
    this.completingTurn = true
    this.completionReasonOverride = null
    const pending = this.pendingTurn
    const monitor = this.currentWorkflowMonitor
    this.currentWorkflowMonitor = null
    this.completingWorkflowMonitor = monitor
    if (opts.drainPiEvents) this.startCancelledTurnDrain()

    void (async () => {
      if (monitor) {
        if (reason === 'end_turn' && !opts.reject && !opts.drainPiEvents) {
          await monitor.waitForRunEndAfterPromptResolution()
        } else {
          await monitor.stopAfterPromptResolution()
        }
      }
      await this.flushEmits()

      const finalReason = this.completionReasonOverride ?? reason
      if (finalReason === 'cancelled') pending.resolve('cancelled')
      else if (opts.reject) pending.reject(opts.reject)
      else pending.resolve(finalReason)

      if (this.promptAckFallbackTimer) {
        clearTimeout(this.promptAckFallbackTimer)
        this.promptAckFallbackTimer = null
      }

      this.pendingTurn = null
      this.inAgentLoop = false
      this.completingTurn = false
      this.completingWorkflowMonitor = null
      this.completionReasonOverride = null
      this.sawAgentActivity = false
      this.currentAgentMessageId = null

      const proceedQueue = (opts.proceedQueue ?? true) && !this.drainingCancelledTurn
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

  private startCancelledTurnDrain(): void {
    this.drainingCancelledTurn = true
    if (this.cancelDrainTimer) clearTimeout(this.cancelDrainTimer)
    this.cancelDrainTimer = setTimeout(() => this.stopCancelledTurnDrain(), CANCEL_DRAIN_TIMEOUT_MS)
  }

  private stopCancelledTurnDrain(): void {
    if (!this.drainingCancelledTurn && !this.cancelDrainTimer) return
    this.drainingCancelledTurn = false
    if (this.cancelDrainTimer) {
      clearTimeout(this.cancelDrainTimer)
      this.cancelDrainTimer = null
    }

    if (!this.pendingTurn && this.turnQueue.length) {
      const next = this.turnQueue.shift()
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next)
      }
    }
  }

  private toolSource(toolCallId: string, eventType: string): PresentationSource {
    return { sessionId: this.sessionId, toolCallId, eventType, sessionFile: this.sessionFile }
  }

  private rawPresentation(value: unknown, toolCallId: string, eventType: string): unknown {
    return safePresentationValue(value, this.toolSource(toolCallId, eventType))
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    if (this.drainingCancelledTurn) {
      if (type === 'agent_end') this.stopCancelledTurnDrain()
      return
    }

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
                  rawInput: this.rawPresentation(rawInput, toolCallId, 'message_update')
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
                rawInput: this.rawPresentation(rawInput, toolCallId, 'message_update')
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

        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const stat = statSync(abs)
              if (stat.size <= TOOL_PRESENTATION_LIMITS.diffFileBytes) {
                const oldText = readFileSync(abs, 'utf8')
                this.editSnapshots.set(toolCallId, { path: p, oldText })

                const needle = typeof args?.oldText === 'string' ? args.oldText : ''
                line = findUniqueLineNumber(oldText, needle)
              } else {
                this.editSnapshots.set(toolCallId, {
                  path: p,
                  skippedReason: `structured diff omitted because pre-edit file is ${stat.size} bytes`
                })
              }
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
            rawInput: this.rawPresentation(args, toolCallId, 'tool_execution_start')
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
            rawInput: this.rawPresentation(args, toolCallId, 'tool_execution_start')
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        const text = toolResultToPresentationText(partial, this.toolSource(toolCallId, 'tool_execution_update'))
        const metadata = this.currentToolMetadata.get(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: this.rawPresentation(partial, toolCallId, 'tool_execution_update')
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToPresentationText(result, this.toolSource(toolCallId, 'tool_execution_end'))

        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          if (snapshot.skippedReason) {
            content = [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: presentationDiagnostic(
                    snapshot.skippedReason,
                    this.toolSource(toolCallId, 'tool_execution_end')
                  )
                }
              },
              ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
            ]
          } else if (snapshot.oldText !== undefined) {
            try {
              const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
              const stat = statSync(abs)
              if (stat.size <= TOOL_PRESENTATION_LIMITS.diffFileBytes) {
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
              } else {
                content = [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: presentationDiagnostic(
                        `structured diff omitted because post-edit file is ${stat.size} bytes`,
                        this.toolSource(toolCallId, 'tool_execution_end')
                      )
                    }
                  },
                  ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
                ]
              }
            } catch {
              // ignore; fall back to text only
            }
          }
        }

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
          rawOutput: this.rawPresentation(result, toolCallId, 'tool_execution_end')
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

function mergeTextChunkUpdate(previous: SessionUpdate, next: SessionUpdate): boolean {
  if (previous.sessionUpdate !== next.sessionUpdate) return false
  if (previous.sessionUpdate !== 'agent_message_chunk' && previous.sessionUpdate !== 'agent_thought_chunk') return false
  const previousContent = (previous as { content?: ContentBlock }).content
  const nextContent = (next as { content?: ContentBlock }).content
  if (previousContent?.type !== 'text' || nextContent?.type !== 'text') return false
  const previousMessageId = (previous as { messageId?: unknown }).messageId
  const nextMessageId = (next as { messageId?: unknown }).messageId
  if (previous.sessionUpdate === 'agent_message_chunk') {
    if (typeof previousMessageId !== 'string' || previousMessageId !== nextMessageId) return false
  } else if (previousMessageId !== nextMessageId) {
    return false
  }

  previousContent.text += nextContent.text
  return true
}

function replaceRoutinePresentationUpdate(previous: OutboundQueueItem, next: OutboundQueueItem): boolean {
  if (!previous.update || !next.update) return false
  if (previous.update.sessionUpdate !== next.update.sessionUpdate) return false
  if (next.update.sessionUpdate !== 'session_info_update' && next.update.sessionUpdate !== 'plan') return false

  previous.update = next.update
  return true
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
