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
import { PiRpcProcess, PiRpcProcessLifecycleError, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
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
  PI_WORKFLOWS_EVENTS_METHOD,
  readWorkflowRun,
  type WorkflowRunControlOptions,
  type WorkflowRunRecord
} from './workflows.js'
import {
  handleExtensionUiRequest,
  isDialogExtensionUiMethod,
  normalizeExtensionUiRequest,
  PI_EXTENSION_UI_EVENT_METHOD
} from './extension-ui.js'
import { PI_USAGE_UPDATE_METHOD, piUsageTelemetryFromPiSessionStats, usageUpdateFromPiSessionStats } from './usage.js'

const CANCEL_ABORT_TIMEOUT_MS = 3_500
const CANCEL_DRAIN_TIMEOUT_MS = 2_000
const CLOSE_CANCEL_TIMEOUT_MS = 5_000
const CLOSE_SETTLEMENT_TIMEOUT_MS = 1_000
const USAGE_REFRESH_DEBOUNCE_MS = 150
const USAGE_REFRESH_MIN_INTERVAL_MS = 250
const AGENT_END_RETRY_GRACE_MS = 100

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

type PromptLifecycleOptions = {
  onAccepted?: (state: unknown) => void | Promise<void>
}

type UsageRefreshResult = {
  stats?: unknown
  state?: unknown
  stale?: boolean
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  lifecycle?: PromptLifecycleOptions
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

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      await s.close()
    } finally {
      this.sessions.delete(sessionId)
    }
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
      if (e instanceof PiRpcProcessLifecycleError) {
        throw RequestError.internalError({}, e.message)
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
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcess; sessionFile?: string | null }
  ): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      sessionFile: params.sessionFile ?? null
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
  private currentAgentMessageText = ''
  private currentAgentMessageOpen = false
  private currentThoughtMessageId: string | null = null
  private currentThoughtOpen = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly cancelAbortTimeoutMs: number
  private readonly cancelDrainTimeoutMs: number
  private sessionFile: string | null

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track started tool calls so duplicated or out-of-order events do not produce extra ACP lifecycle notifications.
  private currentToolCalls = new Map<string, 'in_progress'>()
  private currentToolMetadata = new Map<string, ToolMetadata>()
  private currentToolUpdateResults = new Map<string, unknown[]>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false
  private completingTurn = false
  private sawAgentActivity = false
  private promptAckFallbackTimer: NodeJS.Timeout | null = null
  private agentEndFallbackTimer: NodeJS.Timeout | null = null
  private promptLifecycleActive = false
  private currentWorkflowMonitor: WorkflowEventMonitor | null = null
  private completingWorkflowMonitor: WorkflowEventMonitor | null = null
  private workflowContinuationActive = false
  private workflowContinuationCancel: (() => void) | null = null
  private readonly attachedWorkflowMonitors = new Map<string, WorkflowEventMonitor>()
  private completionReasonOverride: StopReason | null = null
  private drainingCancelledTurn = false
  private cancelDrainTimer: NodeJS.Timeout | null = null
  private turnSettledWaiters: Array<() => void> = []

  private editSnapshots = new Map<string, { path: string; oldText?: string; skippedReason?: string }>()

  private outboundQueue: OutboundQueueItem[] = []
  private sendingOutbound = false
  private drainingOutbound = false
  private outboundDrainWaiters: Array<() => void> = []
  private outboundDiagnosticQueued = false
  private shuttingDown = false
  private outboundPressure: OutboundPressureSnapshot = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    maxPending: 0,
    coalesced: 0,
    diagnostics: 0
  }

  private cachedPiState: unknown
  private usageRefreshTimer: NodeJS.Timeout | null = null
  private usageRefreshInFlight = false
  private usageRefreshQueued = false
  private usageRefreshSequence = 0
  private latestForcedUsageRefreshSequence = 0
  private forcedUsageRefreshInFlight = 0
  private lastUsageRefreshAt = 0
  private lastUsageUpdateKey: string | null = null
  private lastPiUsageTelemetryKey: string | null = null

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    cancelAbortTimeoutMs?: number
    cancelDrainTimeoutMs?: number
    sessionFile?: string | null
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.cancelAbortTimeoutMs = opts.cancelAbortTimeoutMs ?? CANCEL_ABORT_TIMEOUT_MS
    this.cancelDrainTimeoutMs = opts.cancelDrainTimeoutMs ?? CANCEL_DRAIN_TIMEOUT_MS
    this.sessionFile = opts.sessionFile ?? null

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  dispose(opts: { disposeProcess?: boolean; signal?: NodeJS.Signals | number; settle?: boolean } = {}): void {
    this.beginShutdown()
    if (opts.settle !== false) this.settleCancelledWorkForShutdown()
    this.disposeRuntimeResources()
    if (opts.disposeProcess !== false) this.proc.dispose?.(opts.signal ?? 'SIGTERM')
  }

  async close(): Promise<void> {
    console.error(
      `[pi-acp] session/close received sessionId=${this.sessionId} pendingTurn=${Boolean(this.pendingTurn)} workflowContinuation=${this.workflowContinuationActive} queuedTurns=${this.turnQueue.length}`
    )

    this.beginShutdown()

    if (this.hasActiveWork()) {
      try {
        await this.withTimeout(this.cancel(), CLOSE_CANCEL_TIMEOUT_MS, 'session close cancellation')
      } catch (error) {
        console.error(
          `[pi-acp] session close cancellation failed sessionId=${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    this.settleCancelledWorkForShutdown()
    try {
      await this.withTimeout(this.waitForTurnSettlement(), CLOSE_SETTLEMENT_TIMEOUT_MS, 'session close settlement')
    } catch (error) {
      console.error(
        `[pi-acp] session close settlement timed out sessionId=${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const proc = this.proc as PiRpcProcess & {
      terminate?: (opts?: { gracefulTimeoutMs?: number; killTimeoutMs?: number }) => Promise<void>
    }
    if (typeof proc.terminate === 'function') await proc.terminate({ gracefulTimeoutMs: 1_500, killTimeoutMs: 1_500 })
    else proc.dispose?.('SIGTERM')

    this.dispose({ disposeProcess: false, settle: false })
  }

  getSessionFile(): string | null {
    return this.sessionFile
  }

  async prompt(message: string, images: unknown[] = [], lifecycle?: PromptLifecycleOptions): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject, lifecycle }

      // If a turn is already running, enqueue.
      if (this.pendingTurn || this.workflowContinuationActive || this.drainingCancelledTurn) {
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
      `[pi-acp] session/cancel received sessionId=${this.sessionId} pendingTurn=${Boolean(this.pendingTurn)} workflowContinuation=${this.workflowContinuationActive} queuedTurns=${this.turnQueue.length}`
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
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn || this.workflowContinuationActive) } }
      })
    }

    if (!this.pendingTurn) {
      try {
        await this.withTimeout(this.proc.abort(), this.cancelAbortTimeoutMs, 'pi abort')
        if (this.workflowContinuationActive) {
          if (!this.shuttingDown) this.startCancelledTurnDrain()
          this.workflowContinuationCancel?.()
        } else {
          this.completingWorkflowMonitor?.dispose()
          this.completingWorkflowMonitor = null
        }
      } catch (error) {
        console.error(
          `[pi-acp] pi RPC abort ignored with no pending turn: ${error instanceof Error ? error.message : String(error)}`
        )
        if (this.workflowContinuationActive) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Pi did not acknowledge cancellation; restarting the ACP subprocess.' }
          })
          this.workflowContinuationCancel?.()
          this.proc.dispose('SIGKILL')
        } else {
          this.completingWorkflowMonitor?.dispose()
          this.completingWorkflowMonitor = null
        }
      }
      await this.waitForTurnSettlement()
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

    await this.waitForTurnSettlement()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  updateSessionFile(sessionFile: string | null): void {
    this.sessionFile = sessionFile
  }

  updateCachedPiState(state: unknown): void {
    if (state !== undefined) this.cachedPiState = state
  }

  async refreshUsageTelemetry(opts: { includeState?: boolean; force?: boolean } = {}): Promise<UsageRefreshResult> {
    const sequence = ++this.usageRefreshSequence
    const startedDuringForcedRefresh = !opts.force && this.forcedUsageRefreshInFlight > 0

    if (opts.force) {
      this.latestForcedUsageRefreshSequence = sequence
      this.forcedUsageRefreshInFlight += 1
      this.usageRefreshQueued = false
      if (this.usageRefreshTimer) {
        clearTimeout(this.usageRefreshTimer)
        this.usageRefreshTimer = null
      }
    }

    try {
      const [stats, state] = await Promise.all([
        this.proc.getSessionStats().catch(() => undefined),
        opts.includeState ? this.proc.getState().catch(() => undefined) : Promise.resolve(this.cachedPiState)
      ])

      if (sequence < this.latestForcedUsageRefreshSequence || startedDuringForcedRefresh)
        return { stats, state, stale: true }

      if (state !== undefined) this.cachedPiState = state
      if (stats !== undefined) {
        this.publishUsageUpdateFromStats(stats, { force: opts.force })
        this.publishPiUsageTelemetryFromStats(stats, state, { force: opts.force })
        this.lastUsageRefreshAt = Date.now()
      }

      return { stats, state }
    } finally {
      if (opts.force) this.forcedUsageRefreshInFlight = Math.max(0, this.forcedUsageRefreshInFlight - 1)
    }
  }

  publishUsageUpdateFromStats(stats: unknown, opts: { force?: boolean } = {}): void {
    const update = usageUpdateFromPiSessionStats(stats)
    if (!update) return
    const key = stableUsageKey(update)
    if (!opts.force && key === this.lastUsageUpdateKey) return
    this.lastUsageUpdateKey = key
    this.emit(update)
  }

  publishPiUsageTelemetryFromStats(stats: unknown, state?: unknown, opts: { force?: boolean } = {}): void {
    const usage = piUsageTelemetryFromPiSessionStats(stats, state)
    if (!usage) return
    const key = stableUsageKey(usage)
    if (!opts.force && key === this.lastPiUsageTelemetryKey) return
    this.lastPiUsageTelemetryKey = key
    this.emitCustomNotification(PI_USAGE_UPDATE_METHOD, { sessionId: this.sessionId, usage })
  }

  getOutboundPressureSnapshot(): OutboundPressureSnapshot {
    return { ...this.outboundPressure }
  }

  private enqueueOutbound(item: OutboundQueueItem): void {
    if (this.shuttingDown) {
      item.resolve?.()
      return
    }

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
    if (item.resolve || item.reject) return false
    const previous = this.outboundQueue[this.outboundQueue.length - 1]
    if (!previous) return false

    if (item.kind === 'sessionUpdate' && item.update && previous.kind === 'sessionUpdate' && previous.update) {
      if (mergeTextChunkUpdate(previous.update, item.update)) return true
      if (replaceRoutinePresentationUpdate(previous, item)) return true
      if (replacePendingUsageUpdate(previous, item)) return true
    }

    if (item.kind === 'extNotification' && previous.kind === 'extNotification') {
      if (replacePendingUsageNotification(previous, item)) return true
    }

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
    this.resolveAllOutboundDrainWaiters()
  }

  private resolveAllOutboundDrainWaiters(): void {
    const waiters = this.outboundDrainWaiters.splice(0, this.outboundDrainWaiters.length)
    for (const resolve of waiters) resolve()
  }

  private beginShutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const queued = this.outboundQueue.splice(0, this.outboundQueue.length)
    for (const item of queued) item.resolve?.()
    this.updateOutboundPendingPressure()
    this.resolveAllOutboundDrainWaiters()
  }

  private emit(update: SessionUpdate): void {
    this.enqueueOutbound({ kind: 'sessionUpdate', update })
  }

  private emitCustomNotification(method: string, params: Record<string, unknown>): void {
    this.enqueueOutbound({ kind: 'extNotification', method, params })
  }

  private emitWorkflowEventNotification(record: Record<string, unknown>, observedSequence: number): void {
    this.emitCustomNotification(PI_WORKFLOWS_EVENTS_METHOD, {
      sessionId: this.sessionId,
      runId: typeof record.runId === 'string' ? record.runId : undefined,
      sequence: typeof record.sequence === 'number' ? record.sequence : observedSequence,
      event: record
    })
  }

  async continueWorkflowRun(
    run: Pick<WorkflowRunRecord, 'id' | 'runDir'>,
    continuationMessage: string,
    opts: WorkflowRunControlOptions = {}
  ): Promise<StopReason> {
    if (this.pendingTurn || this.workflowContinuationActive) {
      throw RequestError.internalError({}, 'Cannot continue a workflow while another Pi turn is running.')
    }

    this.cancelRequested = false
    this.workflowContinuationActive = true
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true, workflowRunId: run.id } }
    })

    const monitor = new WorkflowEventMonitor(this.cwd, update => this.emit(update), {
      attach: { runId: run.id, runDir: run.runDir, sinceSequence: 0, replay: false },
      onRecord: (record, sequence) => this.emitWorkflowEventNotification(record, sequence),
      onUsageTelemetry: event =>
        this.emitCustomNotification(PI_USAGE_UPDATE_METHOD, {
          sessionId: this.sessionId,
          ...(event.contextSessionId ? { contextSessionId: event.contextSessionId } : {}),
          ...(event.workflow ? { workflow: event.workflow } : {}),
          usage: event.usage
        })
    })
    let cancelContinuation!: () => void
    const cancelPromise = new Promise<StopReason>(resolve => {
      cancelContinuation = () => resolve('cancelled')
    })
    this.workflowContinuationCancel = cancelContinuation
    this.completingWorkflowMonitor = monitor
    monitor.start()

    const workflowPromise = (async (): Promise<StopReason> => {
      await this.proc.workflowControl('resume', run.runDir || run.id, { ...opts, continuationMessage })
      await monitor.waitForRunEndAfterPromptResolution()
      await this.flushEmits()
      return this.cancelRequested ? 'cancelled' : 'end_turn'
    })()

    try {
      return await Promise.race([workflowPromise, cancelPromise])
    } catch (error) {
      if (this.cancelRequested) return 'cancelled'
      throw error
    } finally {
      this.workflowContinuationActive = false
      this.workflowContinuationCancel = null
      monitor.dispose()
      if (this.completingWorkflowMonitor === monitor) this.completingWorkflowMonitor = null
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: this.turnQueue.length, running: Boolean(this.pendingTurn) } }
      })
      this.resolveTurnSettledWaiters()

      if (!this.pendingTurn && !this.drainingCancelledTurn) {
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
  }

  async controlWorkflowRun(
    action: 'interrupt' | 'pause' | 'resume' | 'abort',
    target: string,
    opts: WorkflowRunControlOptions = {}
  ): Promise<unknown> {
    const result = await this.proc.workflowControl(action, target, opts)
    const run = workflowRunFromControlResult(result) ?? readWorkflowRunIfAvailable(target)
    if (run && action !== 'abort') await this.attachWorkflowRun(run, 0)
    return result
  }

  async attachWorkflowRun(run: Pick<WorkflowRunRecord, 'id' | 'runDir'>, sinceSequence = 0): Promise<void> {
    const existing = this.attachedWorkflowMonitors.get(run.id)
    if (existing) return
    const monitor = new WorkflowEventMonitor(this.cwd, update => this.emit(update), {
      attach: { runId: run.id, runDir: run.runDir, sinceSequence },
      onRecord: (record, sequence) => this.emitWorkflowEventNotification(record, sequence),
      onUsageTelemetry: event =>
        this.emitCustomNotification(PI_USAGE_UPDATE_METHOD, {
          sessionId: this.sessionId,
          ...(event.contextSessionId ? { contextSessionId: event.contextSessionId } : {}),
          ...(event.workflow ? { workflow: event.workflow } : {}),
          usage: event.usage
        })
    })
    this.attachedWorkflowMonitors.set(run.id, monitor)
    monitor.start()
    await this.flushEmits()
  }

  private async flushEmits(): Promise<void> {
    if (this.shuttingDown || this.currentOutboundPending() === 0) return
    await new Promise<void>(resolve => this.outboundDrainWaiters.push(resolve))
  }

  private scheduleUsageRefresh(): void {
    if (this.usageRefreshTimer) return

    const elapsed = Date.now() - this.lastUsageRefreshAt
    const delay = Math.max(USAGE_REFRESH_DEBOUNCE_MS, USAGE_REFRESH_MIN_INTERVAL_MS - elapsed)
    this.usageRefreshTimer = setTimeout(() => {
      this.usageRefreshTimer = null
      void this.runScheduledUsageRefresh()
    }, delay)
  }

  private async runScheduledUsageRefresh(): Promise<void> {
    if (this.usageRefreshInFlight) {
      this.usageRefreshQueued = true
      return
    }

    this.usageRefreshInFlight = true
    try {
      const result = await this.refreshUsageTelemetry()
      if (!result.stale) this.lastUsageRefreshAt = Date.now()
    } finally {
      this.usageRefreshInFlight = false
    }

    if (this.usageRefreshQueued) {
      this.usageRefreshQueued = false
      this.scheduleUsageRefresh()
    }
  }

  private hasActiveWork(): boolean {
    return Boolean(
      this.pendingTurn ||
      this.workflowContinuationActive ||
      this.completingTurn ||
      this.drainingCancelledTurn ||
      this.turnQueue.length
    )
  }

  private settleCancelledWorkForShutdown(): void {
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')
    }

    if (this.workflowContinuationActive) this.workflowContinuationCancel?.()

    if (this.pendingTurn) {
      if (!this.interruptCompletingTurn('cancelled')) this.completeTurn('cancelled', { proceedQueue: false })
    } else {
      this.currentWorkflowMonitor?.dispose()
      this.currentWorkflowMonitor = null
      this.completingWorkflowMonitor?.dispose()
      this.completingWorkflowMonitor = null
    }

    if (this.drainingCancelledTurn) this.stopCancelledTurnDrain()
    this.resolveTurnSettledWaiters()
  }

  private disposeRuntimeResources(): void {
    this.currentWorkflowMonitor?.dispose()
    this.currentWorkflowMonitor = null
    this.completingWorkflowMonitor?.dispose()
    this.completingWorkflowMonitor = null
    for (const monitor of this.attachedWorkflowMonitors.values()) monitor.dispose()
    this.attachedWorkflowMonitors.clear()
    if (this.cancelDrainTimer) {
      clearTimeout(this.cancelDrainTimer)
      this.cancelDrainTimer = null
    }
    if (this.usageRefreshTimer) {
      clearTimeout(this.usageRefreshTimer)
      this.usageRefreshTimer = null
    }
    this.clearAgentEndFallbackTimer()
    this.drainingCancelledTurn = false
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

  private waitForTurnSettlement(): Promise<void> {
    if (!this.pendingTurn && !this.workflowContinuationActive && !this.completingTurn && !this.drainingCancelledTurn)
      return Promise.resolve()
    return new Promise(resolve => this.turnSettledWaiters.push(resolve))
  }

  private resolveTurnSettledWaiters(): void {
    if (this.pendingTurn || this.workflowContinuationActive || this.completingTurn || this.drainingCancelledTurn) return
    const waiters = this.turnSettledWaiters.splice(0, this.turnSettledWaiters.length)
    for (const resolve of waiters) resolve()
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.completingTurn = false
    this.completingWorkflowMonitor = null
    this.completionReasonOverride = null
    this.sawAgentActivity = false
    this.promptLifecycleActive = false
    if (this.promptAckFallbackTimer) {
      clearTimeout(this.promptAckFallbackTimer)
      this.promptAckFallbackTimer = null
    }
    this.clearAgentEndFallbackTimer()
    this.stopCancelledTurnDrain()
    this.resetAgentMessageStream()
    this.resetThoughtStream()
    this.beginAgentMessageStream()
    const workflowTarget = parseWorkflowCommandPrompt(t.message)
    this.currentWorkflowMonitor = isWorkflowCommandPrompt(t.message)
      ? new WorkflowEventMonitor(this.cwd, update => this.emit(update), {
          target: workflowTarget ? { ...workflowTarget, parentSessionId: this.sessionId } : null,
          onRecord: (record, sequence) => this.emitWorkflowEventNotification(record, sequence),
          onUsageTelemetry: event =>
            this.emitCustomNotification(PI_USAGE_UPDATE_METHOD, {
              sessionId: this.sessionId,
              ...(event.contextSessionId ? { contextSessionId: event.contextSessionId } : {}),
              ...(event.workflow ? { workflow: event.workflow } : {}),
              usage: event.usage
            })
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
        if (this.shuttingDown) return
        this.handlePromptAccepted(t)
        this.promptAckFallbackTimer = setTimeout(() => {
          this.promptAckFallbackTimer = null
          if (!this.inAgentLoop && !this.sawAgentActivity) {
            this.completeTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
          }
        }, 100)
      })
      .catch(err => {
        if (this.shuttingDown) return
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

  private handlePromptAccepted(t: QueuedTurn): void {
    const onAccepted = t.lifecycle?.onAccepted
    if (!onAccepted) return

    void (async () => {
      const state = await this.proc.getState().catch(() => null)
      this.updateCachedPiState(state)
      await onAccepted(state)
    })().catch(error => {
      console.error(
        `[pi-acp] prompt acceptance hook failed sessionId=${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
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
    if (opts.drainPiEvents && !this.shuttingDown) this.startCancelledTurnDrain()

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
      this.promptLifecycleActive = false
      this.clearAgentEndFallbackTimer()
      this.completingTurn = false
      this.completingWorkflowMonitor = null
      this.completionReasonOverride = null
      this.sawAgentActivity = false
      this.resetAgentMessageStream()
      this.resetThoughtStream()
      this.resolveTurnSettledWaiters()

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
    this.cancelDrainTimer = setTimeout(() => this.stopCancelledTurnDrain(), this.cancelDrainTimeoutMs)
  }

  private stopCancelledTurnDrain(): void {
    if (!this.drainingCancelledTurn && !this.cancelDrainTimer) return
    this.drainingCancelledTurn = false
    if (this.cancelDrainTimer) {
      clearTimeout(this.cancelDrainTimer)
      this.cancelDrainTimer = null
    }

    this.resolveTurnSettledWaiters()

    if (!this.pendingTurn && !this.workflowContinuationActive && this.turnQueue.length) {
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

  private setToolMetadataFromName(toolCallId: string, toolName: unknown): ToolMetadata | undefined {
    if (typeof toolName !== 'string' || !toolName) return undefined
    const metadata = { title: toolName, kind: toToolKind(toolName) }
    this.currentToolMetadata.set(toolCallId, metadata)
    return metadata
  }

  private toolUpdatePresentationText(toolCallId: string): string {
    const updates = this.currentToolUpdateResults.get(toolCallId)
    if (!updates?.length) return ''

    const source = this.toolSource(toolCallId, 'tool_execution_update')
    const text = updates
      .map(update => {
        if (typeof update === 'string') return update
        return toolResultToPresentationText(update, source)
      })
      .filter(Boolean)
      .join('\n')
      .trimEnd()

    return text ? toolResultToPresentationText({ content: [{ type: 'text', text }] }, source) : ''
  }

  private beginAgentMessageStream(): void {
    this.currentAgentMessageId = crypto.randomUUID()
    this.currentAgentMessageText = ''
    this.currentAgentMessageOpen = true
  }

  private resetAgentMessageStream(): void {
    this.currentAgentMessageId = null
    this.currentAgentMessageText = ''
    this.currentAgentMessageOpen = false
  }

  private beginThoughtStream(): void {
    this.currentThoughtMessageId = crypto.randomUUID()
    this.currentThoughtOpen = true
  }

  private resetThoughtStream(): void {
    this.currentThoughtMessageId = null
    this.currentThoughtOpen = false
  }

  private ensureAgentMessageStream(): void {
    if (!this.pendingTurn) return
    if (!this.currentAgentMessageId || !this.currentAgentMessageOpen) this.beginAgentMessageStream()
  }

  private ensureThoughtStream(): void {
    if (!this.currentThoughtMessageId || !this.currentThoughtOpen) this.beginThoughtStream()
  }

  private clearAgentEndFallbackTimer(): void {
    if (!this.agentEndFallbackTimer) return
    clearTimeout(this.agentEndFallbackTimer)
    this.agentEndFallbackTimer = null
  }

  private scheduleAgentEndFallbackCompletion(): void {
    this.clearAgentEndFallbackTimer()
    this.agentEndFallbackTimer = setTimeout(() => {
      this.agentEndFallbackTimer = null
      this.finishAgentEnd()
    }, AGENT_END_RETRY_GRACE_MS)
  }

  private finishAgentEnd(): void {
    const wasDrainingCancelledTurn = this.drainingCancelledTurn
    this.completeTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
    if (wasDrainingCancelledTurn) this.stopCancelledTurnDrain()
  }

  private reconcileAssistantMessageEnd(message: unknown): void {
    const finalText = extractAssistantText(message)
    if (!finalText || isRetryableAssistantError(message)) return

    const streamedText = this.currentAgentMessageText
    if (streamedText === finalText) return
    if (streamedText && !finalText.startsWith(streamedText)) return

    const missingText = streamedText ? finalText.slice(streamedText.length) : finalText
    if (!missingText) return

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      ...(this.currentAgentMessageId ? { messageId: this.currentAgentMessageId } : {}),
      content: { type: 'text', text: missingText } satisfies ContentBlock
    })
    this.currentAgentMessageText = finalText
  }

  private completePromptLifecycle(ev: PiRpcEvent): void {
    this.clearAgentEndFallbackTimer()
    const stopReason = String((ev as any).stopReason ?? '')
    const success = (ev as any).success

    if (this.cancelRequested || stopReason === 'cancelled') {
      const wasDrainingCancelledTurn = this.drainingCancelledTurn
      this.completeTurn('cancelled')
      if (wasDrainingCancelledTurn) this.stopCancelledTurnDrain()
      return
    }

    if (success === false || stopReason === 'error') {
      const message = typeof (ev as any).error === 'string' ? (ev as any).error : 'Pi prompt failed.'
      this.completeTurn('error', { reject: RequestError.internalError({}, message), proceedQueue: false })
      return
    }

    this.finishAgentEnd()
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'prompt_start': {
        this.promptLifecycleActive = true
        this.sawAgentActivity = true
        this.clearAgentEndFallbackTimer()
        break
      }

      case 'prompt_end': {
        this.promptLifecycleActive = true
        this.completePromptLifecycle(ev)
        break
      }

      case 'extension_ui_request': {
        this.handleExtensionUiRequest(ev)
        break
      }

      case 'message_update': {
        this.sawAgentActivity = true
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.ensureAgentMessageStream()
          this.currentAgentMessageText += ame.delta
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            ...(this.currentAgentMessageId ? { messageId: this.currentAgentMessageId } : {}),
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_start') {
          this.beginThoughtStream()
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.ensureThoughtStream()
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            ...(this.currentThoughtMessageId ? { messageId: this.currentThoughtMessageId } : {}),
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_end') {
          this.resetThoughtStream()
          this.scheduleUsageRefresh()
          break
        }

        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'message_start': {
        const role = String((ev as any).message?.role ?? '')
        if (role === 'assistant' && this.pendingTurn) this.beginAgentMessageStream()
        break
      }

      case 'message_end': {
        const role = String((ev as any).message?.role ?? '')
        if (role === 'assistant') {
          this.reconcileAssistantMessageEnd((ev as any).message)
          this.currentAgentMessageOpen = false
          this.currentAgentMessageText = ''
          this.resetThoughtStream()
          this.scheduleUsageRefresh()
        } else if (role === 'toolResult') {
          this.scheduleUsageRefresh()
        }
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

        const metadata = this.setToolMetadataFromName(toolCallId, toolName)!

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
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        this.setToolMetadataFromName(toolCallId, (ev as any).toolName)

        const updates = this.currentToolUpdateResults.get(toolCallId) ?? []
        const partial = (ev as any).partialResult
        const update = (ev as any).update
        if (partial !== undefined) updates.push(partial)
        if (update !== undefined) updates.push(update)
        if (updates.length) this.currentToolUpdateResults.set(toolCallId, updates)
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const finalText = toolResultToPresentationText(result, this.toolSource(toolCallId, 'tool_execution_end'))
        const text = finalText || this.toolUpdatePresentationText(toolCallId)

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

        const metadata =
          this.currentToolMetadata.get(toolCallId) ?? this.setToolMetadataFromName(toolCallId, (ev as any).toolName)
        const rawOutput = result !== undefined ? result : this.currentToolUpdateResults.get(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: this.rawPresentation(rawOutput, toolCallId, 'tool_execution_end')
        })

        this.currentToolCalls.delete(toolCallId)
        this.currentToolMetadata.delete(toolCallId)
        this.currentToolUpdateResults.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
        break
      }

      case 'auto_retry_start': {
        this.clearAgentEndFallbackTimer()
        this.resetAgentMessageStream()
        this.resetThoughtStream()
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
        this.scheduleUsageRefresh()
        break
      }

      case 'agent_start': {
        this.sawAgentActivity = true
        if (this.inAgentLoop) {
          this.resetAgentMessageStream()
          this.resetThoughtStream()
        }
        this.inAgentLoop = true
        this.clearAgentEndFallbackTimer()
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        if (this.promptLifecycleActive) break
        if ((ev as any).willRetry === true) {
          this.clearAgentEndFallbackTimer()
          break
        }
        if ((ev as any).willRetry === false) {
          this.finishAgentEnd()
          break
        }
        this.scheduleAgentEndFallbackCompletion()
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

function workflowRunFromControlResult(value: unknown): Pick<WorkflowRunRecord, 'id' | 'runDir'> | null {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const run = data?.run && typeof data.run === 'object' ? (data.run as Record<string, unknown>) : data
  const id = typeof run?.id === 'string' ? run.id : typeof run?.runId === 'string' ? run.runId : null
  const runDir = typeof run?.runDir === 'string' ? run.runDir : null
  if (!id || !runDir) return null
  return { id, runDir }
}

function readWorkflowRunIfAvailable(target: string): Pick<WorkflowRunRecord, 'id' | 'runDir'> | null {
  try {
    const run = readWorkflowRun(target)
    return { id: run.id, runDir: run.runDir }
  } catch {
    return null
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

function replacePendingUsageUpdate(previous: OutboundQueueItem, next: OutboundQueueItem): boolean {
  if (!previous.update || !next.update) return false
  if (previous.update.sessionUpdate !== 'usage_update' || next.update.sessionUpdate !== 'usage_update') return false

  previous.update = next.update
  return true
}

function replacePendingUsageNotification(previous: OutboundQueueItem, next: OutboundQueueItem): boolean {
  if (previous.method !== PI_USAGE_UPDATE_METHOD || next.method !== PI_USAGE_UPDATE_METHOD) return false

  previous.params = next.params
  return true
}

function stableUsageKey(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

function extractAssistantText(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => {
      if (typeof part === 'string') return part
      if ((part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return ''
    })
    .join('')
}

function isRetryableAssistantError(message: unknown): boolean {
  const msg = message as { stopReason?: unknown; errorMessage?: unknown }
  return msg.stopReason === 'error' && typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0
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
