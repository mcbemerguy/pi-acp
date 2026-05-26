import type { ContentBlock, SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { getAgentDir } from './pi-settings.js'
import { toolResultToText } from './translate/pi-tools.js'
import { toToolCallLocations, toToolKind } from './translate/tool-metadata.js'

type EmitSessionUpdate = (update: SessionUpdate) => void

export type WorkflowEventMonitorTarget = {
  workflowId: string
  commandName?: string
  initialTaskMessage?: string
  parentSessionId?: string
}

type WorkflowEventMonitorOptions = {
  workflowRunsDir?: string
  pollIntervalMs?: number
  graceMs?: number
  runEndMaxWaitMs?: number
  target?: WorkflowEventMonitorTarget | null
  onRecord?: (record: Record<string, unknown>, sequence: number) => void
}

export type WorkflowIngestionSnapshot = {
  recordsObserved: number
  newBytesObserved: number
  fileBytesRead: number
  malformedLines: number
  maxTailBufferBytes: number
  maxActiveTails: number
}

type TailState = {
  filePath: string
  offset: number
  buffer: string
  decoder: StringDecoder
  dev?: number
  ino?: number
  ended: boolean
}

type TerminalRunJsonFallbackState = {
  record: Record<string, unknown>
  recordKey: string
  observedAt: number
  tailOffsetsKey: string
}

type WorkflowMeta = {
  runId: string
  workflowId?: string
  commandName?: string
  runDir?: string
  auditPath?: string
  stepId?: string
  childSessionId?: string
}

type StepPlan = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

type ChildMessageIdentity = {
  sourceKey: string
  hasExplicitId: boolean
}

type ChildToolMetadata = {
  title: string
  kind: ToolKind
}

export function isWorkflowCommandPrompt(message: string): boolean {
  return /^\s*\/workflow:[^\s]+(?:\s|$)/.test(message)
}

export function parseWorkflowCommandPrompt(message: string): WorkflowEventMonitorTarget | null {
  const match = /^\s*\/workflow:([^\s]+)(?:\s+([\s\S]*))?$/.exec(message)
  if (!match) return null
  const workflowId = match[1]?.trim()
  if (!workflowId) return null
  const rawArgs = (match[2] ?? '').trim()
  const initialTaskMessage = rawArgs.startsWith('--') ? rawArgs.slice(2).trimStart() : rawArgs
  return {
    workflowId,
    commandName: `workflow:${workflowId}`,
    ...(initialTaskMessage ? { initialTaskMessage } : {})
  }
}

export class WorkflowEventMapper {
  private readonly cwd: string
  private readonly seen = new Set<string>()
  private readonly runs = new Set<string>()
  private readonly steps = new Map<string, StepPlan>()
  private readonly childTools = new Set<string>()
  private readonly childToolMetadata = new Map<string, ChildToolMetadata>()
  private readonly childTextDeltas = new Set<string>()
  private readonly pendingNoIdTextDeltas = new Set<string>()
  private readonly noIdMessageSequences = new Map<string, number>()

  constructor(cwd: string) {
    this.cwd = cwd
  }

  map(record: unknown): SessionUpdate[] {
    if (!isObject(record)) return []
    const type = stringField(record.type)
    const runId = stringField(record.runId)
    if (!type || !runId) return []

    const dedupeKey = eventDedupeKey(record)
    if (this.seen.has(dedupeKey)) return []
    this.seen.add(dedupeKey)

    switch (type) {
      case 'run_start':
        return this.mapRunStart(record, runId)
      case 'run_end':
        return this.mapRunEnd(record, runId)
      case 'step_start':
      case 'step_update':
      case 'step_end':
        return this.mapStep(record, runId, type)
      case 'inline_subworkflow_start':
        return this.mapStep({ ...record, stepType: 'workflow', status: 'running' }, runId, 'step_start')
      case 'inline_subworkflow_end':
        return this.mapStep(
          { ...record, stepType: 'workflow', status: stringField(record.status) ?? 'completed' },
          runId,
          'step_end'
        )
      case 'subworkflow_call_start':
      case 'subworkflow_call_end':
        return this.mapSubWorkflowCall(record, runId, type)
      case 'child_pi_event':
        return this.mapChildPiEvent(record, runId)
      default:
        return []
    }
  }

  private mapRunStart(record: Record<string, unknown>, runId: string): SessionUpdate[] {
    const workflowId = stringField(record.workflowId) ?? 'workflow'
    this.runs.add(runId)
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId: workflowToolId(runId),
        title: `Workflow: ${workflowId}`,
        kind: 'other',
        status: 'in_progress',
        rawInput: withWorkflowMeta(
          {
            runId,
            workflowId,
            commandName: stringField(record.commandName),
            runDir: stringField(record.runDir),
            auditPath: stringField(record.auditPath)
          },
          metaFromRecord(record)
        ),
        _meta: { piWorkflow: metaFromRecord(record) }
      }
    ]
  }

  private mapRunEnd(record: Record<string, unknown>, runId: string): SessionUpdate[] {
    const workflowId = stringField(record.workflowId) ?? 'workflow'
    const status = isFailedStatus(record) ? 'failed' : 'completed'
    const meta = metaFromRecord(record)
    const updates: SessionUpdate[] = []

    if (!this.runs.has(runId)) {
      this.runs.add(runId)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId: workflowToolId(runId),
        title: `Workflow: ${workflowId}`,
        kind: 'other',
        status: 'in_progress',
        rawInput: withWorkflowMeta({ runId, workflowId }, meta),
        _meta: { piWorkflow: meta }
      })
    }

    const finalPlan = this.completeOpenPlanEntries(runId)
    if (finalPlan) updates.push(finalPlan)

    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: workflowToolId(runId),
      status,
      rawOutput: withWorkflowMeta({ status: stringField(record.status), error: stringField(record.error) }, meta),
      _meta: { piWorkflow: meta }
    })

    const auditPath = stringField(record.auditPath)
    const auditUri = auditPath ? pathToFileURL(auditPath).href : undefined
    const summary = `Workflow ${workflowId} ${status === 'failed' ? 'failed' : 'completed'}${auditUri ? `. Audit: [audit.md](<${auditUri}>)` : '.'}`
    updates.push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: summary } satisfies ContentBlock,
      _meta: { piWorkflow: meta }
    })
    if (auditPath) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource_link',
          name: 'audit.md',
          uri: pathToFileURL(auditPath).href,
          mimeType: 'text/markdown',
          title: `Workflow ${workflowId} audit`
        } as ContentBlock,
        _meta: { piWorkflow: meta }
      })
    }
    return updates
  }

  private mapStep(record: Record<string, unknown>, runId: string, type: string): SessionUpdate[] {
    const stepId = stringField(record.stepId)
    if (!stepId) return []

    const toolCallId = stepToolId(runId, stepId)
    const stepContent = stepTitle(record, stepId)
    this.steps.set(toolCallId, { id: toolCallId, content: stepContent, status: planStatus(record, type) })

    const plan = this.planUpdate()
    return plan ? [plan] : []
  }

  private mapSubWorkflowCall(record: Record<string, unknown>, runId: string, type: string): SessionUpdate[] {
    const stepId = stringField(record.stepId)
    const startedAt = stringField(record.startedAt)
    const childWorkflowId = stringField(record.childWorkflowId) ?? stringField(record.workflowId) ?? 'workflow'
    const toolName = stringField(record.toolName) ?? childWorkflowId
    if (!stepId || !startedAt) return []

    const toolCallId = subWorkflowCallToolId(runId, stepId, toolName, startedAt)
    const existing = this.steps.get(toolCallId)
    this.steps.set(toolCallId, {
      id: toolCallId,
      content: subWorkflowCallTitle(record, childWorkflowId, toolName, existing?.content),
      status: type === 'subworkflow_call_end' ? 'completed' : 'in_progress'
    })

    const plan = this.planUpdate()
    return plan ? [plan] : []
  }

  private mapChildPiEvent(record: Record<string, unknown>, runId: string): SessionUpdate[] {
    const childType = stringField(record.childEventType)
    const stepId = stringField(record.stepId)
    const event = isObject(record.event) ? record.event : undefined
    if (!childType || !stepId || !event) return []

    if (childType === 'message_update') return this.mapChildMessageUpdate(record, runId, stepId, event)
    if (childType === 'message_end') return this.mapChildMessageEnd(record, runId, stepId, event)
    if (!childType.startsWith('tool_execution_')) return []

    const childToolCallId = stringField(event.toolCallId)
    if (!childToolCallId) return []

    const toolCallId = childToolId(runId, stepId, childToolCallId)
    const toolName = stringField(event.toolName) ?? 'tool'
    const args = event.args
    const result = childType === 'tool_execution_update' ? event.partialResult : event.result
    const meta = metaFromRecord(record)
    const locations = toToolCallLocations(args, this.cwd)
    const updates: SessionUpdate[] = []

    if (childType === 'tool_execution_start') {
      const metadata = { title: toolName, kind: toToolKind(toolName) }
      this.childTools.add(toolCallId)
      this.childToolMetadata.set(toolCallId, metadata)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: metadata.title,
        kind: metadata.kind,
        status: 'in_progress',
        locations,
        rawInput: withWorkflowMeta(args, meta),
        _meta: { piWorkflow: meta }
      })
      return updates
    }

    let metadata = this.childToolMetadata.get(toolCallId)
    if (!metadata && toolName !== 'tool') {
      metadata = { title: toolName, kind: toToolKind(toolName) }
      this.childToolMetadata.set(toolCallId, metadata)
    }

    if (!this.childTools.has(toolCallId)) {
      metadata = metadata ?? { title: toolName, kind: toToolKind(toolName) }
      this.childTools.add(toolCallId)
      this.childToolMetadata.set(toolCallId, metadata)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: metadata.title,
        kind: metadata.kind,
        status: 'in_progress',
        locations,
        rawInput: withWorkflowMeta(args, meta),
        _meta: { piWorkflow: meta }
      })
    }

    const text = toolResultToText(result)
    const content = text
      ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
      : undefined
    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
      status: childType === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'in_progress',
      content,
      rawOutput: withWorkflowMeta(result, meta),
      _meta: { piWorkflow: meta }
    })
    if (childType === 'tool_execution_end') this.childToolMetadata.delete(toolCallId)
    return updates
  }

  private mapChildMessageUpdate(
    record: Record<string, unknown>,
    runId: string,
    stepId: string,
    event: Record<string, unknown>
  ): SessionUpdate[] {
    const assistantMessageEvent = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined
    const delta = stringField(assistantMessageEvent?.delta)
    if (!assistantMessageEvent || !delta) return []

    const meta = metaFromRecord(record)
    const identity = this.childMessageIdentity(runId, stepId, meta.childSessionId, event, assistantMessageEvent)

    if (assistantMessageEvent.type === 'text_delta') {
      this.childTextDeltas.add(identity.sourceKey)
      if (!identity.hasExplicitId) this.pendingNoIdTextDeltas.add(identity.sourceKey)
      return [
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: stableUuid(identity.sourceKey),
          content: { type: 'text', text: delta } satisfies ContentBlock,
          _meta: { piWorkflow: meta }
        }
      ]
    }

    if (assistantMessageEvent.type === 'thinking_delta') {
      return [
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: delta } satisfies ContentBlock,
          _meta: { piWorkflow: meta }
        }
      ]
    }

    return []
  }

  private mapChildMessageEnd(
    record: Record<string, unknown>,
    runId: string,
    stepId: string,
    event: Record<string, unknown>
  ): SessionUpdate[] {
    const message = isObject(event.message) ? event.message : undefined
    const text = assistantText(message)
    if (!text) return []

    const meta = metaFromRecord(record)
    const identity = this.childMessageIdentity(runId, stepId, meta.childSessionId, event)
    if (this.childTextDeltas.has(identity.sourceKey)) return []

    const pendingNoIdIdentity = this.currentNoIdChildMessageIdentity(runId, stepId, meta.childSessionId)
    if (this.pendingNoIdTextDeltas.has(pendingNoIdIdentity.sourceKey)) {
      this.pendingNoIdTextDeltas.delete(pendingNoIdIdentity.sourceKey)
      this.advanceNoIdChildMessageSequence(runId, stepId, meta.childSessionId)
      return []
    }

    this.childTextDeltas.add(identity.sourceKey)
    if (!identity.hasExplicitId) this.advanceNoIdChildMessageSequence(runId, stepId, meta.childSessionId)

    return [
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: stableUuid(identity.sourceKey),
        content: { type: 'text', text } satisfies ContentBlock,
        _meta: { piWorkflow: meta }
      }
    ]
  }

  private childMessageIdentity(
    runId: string,
    stepId: string,
    childSessionId: string | undefined,
    event: Record<string, unknown>,
    assistantMessageEvent?: Record<string, unknown>
  ): ChildMessageIdentity {
    const explicitId = childMessageExplicitId(event, assistantMessageEvent)
    if (explicitId)
      return { sourceKey: childMessageSourceKey(runId, stepId, childSessionId, explicitId), hasExplicitId: true }
    return this.currentNoIdChildMessageIdentity(runId, stepId, childSessionId)
  }

  private currentNoIdChildMessageIdentity(
    runId: string,
    stepId: string,
    childSessionId: string | undefined
  ): ChildMessageIdentity {
    const baseKey = childMessageNoIdBaseKey(runId, stepId, childSessionId)
    const sequence = this.noIdMessageSequences.get(baseKey) ?? 0
    return { sourceKey: `${baseKey}:seq:${sequence}`, hasExplicitId: false }
  }

  private advanceNoIdChildMessageSequence(runId: string, stepId: string, childSessionId: string | undefined): void {
    const baseKey = childMessageNoIdBaseKey(runId, stepId, childSessionId)
    this.noIdMessageSequences.set(baseKey, (this.noIdMessageSequences.get(baseKey) ?? 0) + 1)
  }

  private completeOpenPlanEntries(runId: string): SessionUpdate | null {
    let changed = false
    const stepPrefix = `workflow:${runId}:step:`
    for (const step of this.steps.values()) {
      if (step.status !== 'in_progress' || !step.id.startsWith(stepPrefix)) continue
      step.status = 'completed'
      changed = true
    }
    return changed ? this.planUpdate() : null
  }

  private planUpdate(): SessionUpdate | null {
    if (!this.steps.size) return null
    return {
      sessionUpdate: 'plan',
      entries: Array.from(this.steps.values()).map(step => ({
        content: step.content,
        priority: 'medium',
        status: step.status,
        _meta: { piWorkflow: { toolCallId: step.id } }
      }))
    }
  }
}

type WorkflowRunMetadata = {
  runId?: string
  workflowId?: string
  rootWorkflowId?: string
  commandName?: string
  cwd?: string
  initialTaskMessage?: string
  parentSessionId?: string
  runDir?: string
  auditPath?: string
}

type RunMatch = 'accept' | 'reject' | 'unknown'

const DEFAULT_RUN_END_MAX_WAIT_MS = 4 * 60 * 60 * 1000
const TAIL_READ_CHUNK_BYTES = 64 * 1024
const METADATA_READ_CHUNK_BYTES = 16 * 1024
const METADATA_MAX_LINES = 50
const METADATA_MAX_BYTES = 64 * 1024

export class WorkflowEventMonitor {
  private readonly workflowRunsDir: string
  private readonly pollIntervalMs: number
  private readonly graceMs: number
  private readonly runEndMaxWaitMs: number
  private readonly emit: EmitSessionUpdate
  private readonly mapper: WorkflowEventMapper
  private readonly target: WorkflowEventMonitorTarget | null
  private readonly cwdKey: string
  private readonly onRecord?: (record: Record<string, unknown>, sequence: number) => void
  private readonly ingestion: WorkflowIngestionSnapshot = {
    recordsObserved: 0,
    newBytesObserved: 0,
    fileBytesRead: 0,
    malformedLines: 0,
    maxTailBufferBytes: 0,
    maxActiveTails: 0
  }
  private readonly knownDirs = new Set<string>()
  private readonly tails = new Map<string, TailState>()
  private acceptedRunDir: string | null = null
  private interval: NodeJS.Timeout | null = null
  private stopPromise: Promise<void> | null = null
  private stopResolve: (() => void) | null = null
  private stopRequestedAt: number | null = null
  private stopMode: 'grace' | 'run_end' | null = null
  private terminalRunJsonFallback: TerminalRunJsonFallbackState | null = null

  constructor(cwd: string, emit: EmitSessionUpdate, options: WorkflowEventMonitorOptions = {}) {
    this.workflowRunsDir = options.workflowRunsDir ?? join(getAgentDir(), 'workflow-runs')
    this.pollIntervalMs = options.pollIntervalMs ?? 75
    this.graceMs = options.graceMs ?? 350
    this.runEndMaxWaitMs = options.runEndMaxWaitMs ?? DEFAULT_RUN_END_MAX_WAIT_MS
    this.emit = emit
    this.mapper = new WorkflowEventMapper(cwd)
    this.target = options.target ?? null
    this.cwdKey = cwdComparableKey(cwd)
    this.onRecord = options.onRecord
  }

  start(): void {
    this.snapshotKnownDirs()
    this.interval = setInterval(() => this.tick(), this.pollIntervalMs)
    this.interval.unref?.()
    this.tick()
  }

  stopAfterPromptResolution(): Promise<void> {
    return this.requestStop('grace')
  }

  waitForRunEndAfterPromptResolution(): Promise<void> {
    return this.requestStop('run_end')
  }

  getIngestionSnapshot(): WorkflowIngestionSnapshot {
    return { ...this.ingestion }
  }

  private requestStop(mode: 'grace' | 'run_end'): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopRequestedAt = Date.now()
    this.stopMode = mode
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve
    })
    this.tick()
    return this.stopPromise
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.stopResolve?.()
    this.stopResolve = null
  }

  private snapshotKnownDirs(): void {
    for (const dir of listRunDirs(this.workflowRunsDir)) this.knownDirs.add(dir)
  }

  private tick(): void {
    this.discoverRuns()
    this.ingestion.maxActiveTails = Math.max(
      this.ingestion.maxActiveTails,
      Array.from(this.tails.values()).filter(tail => !tail.ended).length
    )
    for (const tail of this.tails.values()) this.readTail(tail)
    this.syncAcceptedRunJsonTerminalState()
    this.maybeFinish()
  }

  private discoverRuns(): void {
    if (this.acceptedRunDir) return

    for (const dir of listRunDirs(this.workflowRunsDir)) {
      if (this.knownDirs.has(dir)) continue
      const runDir = join(this.workflowRunsDir, dir)
      const match = this.matchRunDir(dir, runDir)
      if (match === 'unknown') continue
      this.knownDirs.add(dir)
      if (match === 'reject') continue
      this.acceptRunDir(dir, runDir)
      break
    }
  }

  private acceptRunDir(dir: string, runDir: string): void {
    this.acceptedRunDir = dir
    const eventsPath = join(runDir, 'events.jsonl')
    this.tails.set(eventsPath, createTail(eventsPath))
  }

  private matchRunDir(dir: string, runDir: string): RunMatch {
    if (this.acceptedRunDir) return dir === this.acceptedRunDir ? 'accept' : 'reject'
    if (!this.target) return 'accept'
    const metadata = readWorkflowRunMetadata(runDir)
    if (!metadata) return 'unknown'
    return metadataMatchesTarget(metadata, this.target, this.cwdKey)
  }

  private readTail(tail: TailState): void {
    if (tail.ended) return
    let text = ''
    try {
      const stat = statSync(tail.filePath)
      if (!stat.isFile()) return
      if (tailIdentityChanged(tail, stat.dev, stat.ino) || stat.size < tail.offset) resetTail(tail)
      tail.dev = stat.dev
      tail.ino = stat.ino
      if (stat.size === tail.offset) return
      const previousOffset = tail.offset
      const read = readFileRange(tail.filePath, previousOffset, stat.size, tail.decoder)
      if (!read || read.bytesRead <= 0) return
      text = read.text
      this.ingestion.fileBytesRead += read.bytesRead
      this.ingestion.newBytesObserved += read.bytesRead
      tail.offset = previousOffset + read.bytesRead
    } catch {
      return
    }

    const lines = (tail.buffer + text).split(/\r?\n/)
    tail.buffer = lines.pop() ?? ''
    this.ingestion.maxTailBufferBytes = Math.max(this.ingestion.maxTailBufferBytes, Buffer.byteLength(tail.buffer))
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let record: unknown
      try {
        record = JSON.parse(trimmed)
      } catch {
        this.ingestion.malformedLines += 1
        continue
      }
      if (isObject(record)) {
        this.ingestion.recordsObserved += 1
        this.onRecord?.(record, this.ingestion.recordsObserved - 1)
      }
      for (const update of this.mapper.map(record)) this.emit(update)
      if (isObject(record) && record.type === 'run_end') tail.ended = true
    }
  }

  private syncAcceptedRunJsonTerminalState(): void {
    if (!this.acceptedRunDir) return
    const activeTails = Array.from(this.tails.values()).filter(tail => !tail.ended)
    if (!activeTails.length) {
      this.terminalRunJsonFallback = null
      return
    }

    const runDir = join(this.workflowRunsDir, this.acceptedRunDir)
    const record = readTerminalRunEndRecord(runDir, this.acceptedRunDir)
    if (!record) {
      this.terminalRunJsonFallback = null
      return
    }

    const now = Date.now()
    const tailOffsetsKey = activeTailOffsetsKey(activeTails)
    const recordKey = terminalRunJsonFallbackRecordKey(record)
    if (
      !this.terminalRunJsonFallback ||
      this.terminalRunJsonFallback.tailOffsetsKey !== tailOffsetsKey ||
      this.terminalRunJsonFallback.recordKey !== recordKey
    ) {
      this.terminalRunJsonFallback = { record, recordKey, observedAt: now, tailOffsetsKey }
      return
    }
    if (!this.shouldEmitTerminalRunJsonFallback(this.terminalRunJsonFallback, now)) return

    for (const update of this.mapper.map(record)) this.emit(update)
    for (const tail of activeTails) tail.ended = true
    this.terminalRunJsonFallback = null
  }

  private shouldEmitTerminalRunJsonFallback(state: TerminalRunJsonFallbackState, now: number): boolean {
    if (this.stopRequestedAt === null) return false
    const stopElapsed = now - this.stopRequestedAt
    const terminalElapsed = now - state.observedAt
    if (this.stopMode === 'run_end' && this.runEndMaxWaitMs > 0 && stopElapsed >= this.runEndMaxWaitMs) return true
    return stopElapsed >= this.graceMs && terminalElapsed >= this.graceMs
  }

  private emitRunEndTimeoutFallback(): void {
    if (!this.acceptedRunDir) return
    const runDir = join(this.workflowRunsDir, this.acceptedRunDir)
    const metadata = readWorkflowRunMetadata(runDir) ?? {}
    const runId = metadata.runId ?? this.acceptedRunDir
    const workflowId = metadata.rootWorkflowId ?? metadata.workflowId ?? this.target?.workflowId ?? 'workflow'
    const message = `Workflow run_end was not observed within ${this.runEndMaxWaitMs}ms; ending the ACP turn.`
    const fallbackRecord = {
      type: 'run_end',
      timestamp: new Date().toISOString(),
      runId,
      rootWorkflowId: metadata.rootWorkflowId ?? workflowId,
      workflowId,
      commandName: metadata.commandName,
      cwd: metadata.cwd,
      parentSessionId: metadata.parentSessionId,
      runDir,
      auditPath: metadata.auditPath,
      status: 'failed',
      error: message
    }
    for (const update of this.mapper.map(fallbackRecord)) this.emit(update)
    for (const tail of this.tails.values()) tail.ended = true
  }

  private maybeFinish(): void {
    if (this.stopRequestedAt === null) return
    const elapsed = Date.now() - this.stopRequestedAt
    const graceElapsed = elapsed >= this.graceMs
    const noActiveTails = Array.from(this.tails.values()).every(tail => tail.ended)

    if (this.stopMode === 'run_end') {
      if (this.acceptedRunDir && noActiveTails) {
        this.dispose()
        return
      }
      if (this.acceptedRunDir && this.runEndMaxWaitMs > 0 && elapsed >= this.runEndMaxWaitMs) {
        this.emitRunEndTimeoutFallback()
        this.dispose()
        return
      }
      if (!this.acceptedRunDir && graceElapsed) this.dispose()
      return
    }

    if (this.terminalRunJsonFallback && !noActiveTails) return
    if (!graceElapsed && !noActiveTails) return
    if (!graceElapsed && this.tails.size === 0) return
    this.dispose()
  }
}

function createTail(filePath: string): TailState {
  return { filePath, offset: 0, buffer: '', decoder: new StringDecoder('utf8'), ended: false }
}

function resetTail(tail: TailState): void {
  tail.offset = 0
  tail.buffer = ''
  tail.decoder = new StringDecoder('utf8')
}

function tailIdentityChanged(tail: TailState, dev: number, ino: number): boolean {
  return tail.dev !== undefined && tail.ino !== undefined && (tail.dev !== dev || tail.ino !== ino)
}

function activeTailOffsetsKey(tails: TailState[]): string {
  return tails.map(tail => `${tail.filePath}:${tail.offset}:${Buffer.byteLength(tail.buffer)}`).join('|')
}

function terminalRunJsonFallbackRecordKey(record: Record<string, unknown>): string {
  const stableRecord = { ...record }
  delete stableRecord.timestamp
  return stableStringify(stableRecord)
}

function readFileRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
  decoder: StringDecoder
): { text: string; bytesRead: number } | null {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.min(TAIL_READ_CHUNK_BYTES, Math.max(1, endOffset - startOffset)))
    let position = startOffset
    let text = ''
    while (position < endOffset) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.byteLength, endOffset - position), position)
      if (bytesRead <= 0) break
      position += bytesRead
      text += decoder.write(buffer.subarray(0, bytesRead))
    }
    return { text, bytesRead: position - startOffset }
  } finally {
    closeSync(fd)
  }
}

function listRunDirs(workflowRunsDir: string): string[] {
  try {
    return readdirSync(workflowRunsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function readWorkflowRunMetadata(runDir: string): WorkflowRunMetadata | null {
  const runJson = readJsonObject(join(runDir, 'run.json'))
  if (runJson) return metadataFromRunJson(runJson, runDir)
  return readMetadataFromEvents(join(runDir, 'events.jsonl'))
}

function readTerminalRunEndRecord(runDir: string, fallbackRunId: string): Record<string, unknown> | null {
  const runJson = readJsonObject(join(runDir, 'run.json'))
  if (!runJson) return null

  const status = stringField(runJson.status)?.toLowerCase()
  const endedAt = stringField(runJson.endedAt)
  if (!endedAt && (!status || status === 'running')) return null

  const metadata = metadataFromRunJson(runJson, runDir)
  return {
    type: 'run_end',
    timestamp: endedAt ?? new Date().toISOString(),
    runId: metadata.runId ?? fallbackRunId,
    rootWorkflowId: metadata.rootWorkflowId ?? metadata.workflowId,
    workflowId: metadata.workflowId ?? metadata.rootWorkflowId,
    commandName: metadata.commandName,
    cwd: metadata.cwd,
    parentSessionId: metadata.parentSessionId,
    runDir: metadata.runDir ?? runDir,
    auditPath: metadata.auditPath,
    status: !status || status === 'running' ? 'completed' : status,
    error: stringField(runJson.error)
  }
}

function metadataFromRunJson(runJson: Record<string, unknown>, runDir: string): WorkflowRunMetadata {
  return {
    runId: stringField(runJson.id),
    workflowId: stringField(runJson.workflowId),
    rootWorkflowId: stringField(runJson.rootWorkflowId) ?? stringField(runJson.workflowId),
    commandName: stringField(runJson.commandName),
    cwd: stringField(runJson.cwd),
    initialTaskMessage: stringField(runJson.initialTaskMessage),
    parentSessionId: stringField(runJson.parentSessionId),
    runDir: stringField(runJson.runDir) ?? runDir,
    auditPath: stringField(runJson.auditPath)
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readMetadataFromEvents(eventsPath: string): WorkflowRunMetadata | null {
  const lines = readInitialLines(eventsPath, METADATA_MAX_LINES, METADATA_MAX_BYTES)
  if (!lines) return null

  const metadata: WorkflowRunMetadata = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(record)) continue
    metadata.runId ??= stringField(record.runId)
    metadata.rootWorkflowId ??= stringField(record.rootWorkflowId)
    metadata.workflowId ??= stringField(record.workflowId)
    metadata.commandName ??= stringField(record.commandName)
    metadata.cwd ??= stringField(record.cwd)
    metadata.initialTaskMessage ??= stringField(record.initialTaskMessage)
    metadata.parentSessionId ??= stringField(record.parentSessionId)
    metadata.runDir ??= stringField(record.runDir)
    metadata.auditPath ??= stringField(record.auditPath)
  }
  return metadata.runId || metadata.workflowId || metadata.rootWorkflowId || metadata.commandName || metadata.cwd
    ? metadata
    : null
}

function readInitialLines(filePath: string, maxLines: number, maxBytes: number): string[] | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.allocUnsafe(Math.min(METADATA_READ_CHUNK_BYTES, maxBytes))
    let text = ''
    let lineCount = 0
    let totalBytesRead = 0
    while (lineCount < maxLines && totalBytesRead < maxBytes) {
      const bytesToRead = Math.min(buffer.byteLength, maxBytes - totalBytesRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, null)
      if (bytesRead <= 0) break
      totalBytesRead += bytesRead
      const chunk = decoder.write(buffer.subarray(0, bytesRead))
      text += chunk
      lineCount += countLineBreaks(chunk)
    }
    text += decoder.end()
    return text.split(/\r?\n/).slice(0, maxLines)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function countLineBreaks(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1
  }
  return count
}

function metadataMatchesTarget(
  metadata: WorkflowRunMetadata,
  target: WorkflowEventMonitorTarget,
  cwdKey: string
): RunMatch {
  const workflowId = metadata.rootWorkflowId ?? metadata.workflowId
  const commandName = metadata.commandName
  if ((!workflowId && !commandName) || !metadata.cwd) return 'unknown'
  if (cwdComparableKey(metadata.cwd) !== cwdKey) return 'reject'
  const workflowMatches = workflowId === target.workflowId
  const commandMatches = Boolean(target.commandName && commandName === target.commandName)
  if (!workflowMatches && !commandMatches) {
    if (target.commandName && commandName === undefined) return 'unknown'
    return 'reject'
  }
  if (target.initialTaskMessage !== undefined) {
    if (metadata.initialTaskMessage === undefined) return 'unknown'
    if (metadata.initialTaskMessage !== target.initialTaskMessage) return 'reject'
  }
  if (target.parentSessionId) {
    if (metadata.parentSessionId === undefined) return 'unknown'
    if (metadata.parentSessionId !== target.parentSessionId) return 'reject'
  }
  return 'accept'
}

function cwdComparableKey(cwd: string): string {
  return resolve(cwd)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function eventDedupeKey(record: Record<string, unknown>): string {
  return stableStringify(record)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function workflowToolId(runId: string): string {
  return `workflow:${runId}`
}

function stepToolId(runId: string, stepId: string): string {
  return `workflow:${runId}:step:${stepId}`
}

function childToolId(runId: string, stepId: string, toolCallId: string): string {
  return `workflow:${runId}:step:${stepId}:tool:${toolCallId}`
}

function subWorkflowCallToolId(runId: string, stepId: string, toolName: string, startedAt: string): string {
  return ['workflow', runId, 'step', stepId, 'subworkflow', toolName, startedAt].map(encodeIdPart).join(':')
}

function metaFromRecord(record: Record<string, unknown>): WorkflowMeta {
  return {
    runId: String(record.runId),
    workflowId: stringField(record.workflowId),
    commandName: stringField(record.commandName),
    runDir: stringField(record.runDir),
    auditPath: stringField(record.auditPath),
    stepId: stringField(record.stepId),
    childSessionId: stringField(record.childSessionId)
  }
}

function withWorkflowMeta(value: unknown, meta: WorkflowMeta): unknown {
  if (isObject(value)) return { ...value, _meta: { ...(isObject(value._meta) ? value._meta : {}), piWorkflow: meta } }
  return { value, _meta: { piWorkflow: meta } }
}

function isFailedStatus(record: Record<string, unknown>): boolean {
  const status = stringField(record.status)?.toLowerCase()
  return status === 'failed' || status === 'error' || status === 'aborted' || Boolean(record.error)
}

function planStatus(record: Record<string, unknown>, type: string): 'pending' | 'in_progress' | 'completed' {
  if (type === 'step_end') return 'completed'
  const status = stringField(record.status)?.toLowerCase()
  if (status === 'completed' || status === 'failed' || status === 'error') return 'completed'
  return 'in_progress'
}

function stepTitle(record: Record<string, unknown>, stepId: string): string {
  const stepType = stringField(record.stepType)
  return stepType ? `Workflow step: ${stepId} (${stepType})` : `Workflow step: ${stepId}`
}

function subWorkflowCallTitle(
  record: Record<string, unknown>,
  childWorkflowId: string,
  toolName: string,
  fallback?: string
): string {
  const label = toolName !== childWorkflowId ? `${childWorkflowId} via ${toolName}` : childWorkflowId
  const task = stringField(record.task)
  if (task) return `Subworkflow: ${label} — ${truncateOneLine(task, 180)}`
  return fallback ?? `Subworkflow: ${label}`
}

function truncateOneLine(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

function assistantText(message: Record<string, unknown> | undefined): string {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return ''
  for (const part of message.content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') return part.text
  }
  return ''
}

function childMessageExplicitId(
  event: Record<string, unknown>,
  assistantMessageEvent?: Record<string, unknown>
): string | undefined {
  return (
    stringField(event.messageId) ??
    (isObject(event.message) ? stringField(event.message.id) : undefined) ??
    (isObject(assistantMessageEvent?.partial) ? stringField(assistantMessageEvent.partial.id) : undefined)
  )
}

function childMessageSourceKey(
  runId: string,
  stepId: string,
  childSessionId: string | undefined,
  messageId: string
): string {
  return ['workflow', runId, 'step', stepId, 'child', childSessionId ?? 'unknown', 'message', messageId]
    .map(encodeIdPart)
    .join(':')
}

function childMessageNoIdBaseKey(runId: string, stepId: string, childSessionId: string | undefined): string {
  return childMessageSourceKey(runId, stepId, childSessionId, 'current')
}

function stableUuid(value: string): string {
  const bytes = createHash('sha1').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value)
}
