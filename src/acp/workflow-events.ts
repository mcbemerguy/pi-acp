import type { ContentBlock, SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { getAgentDir } from './pi-settings.js'
import {
  TOOL_PRESENTATION_LIMITS,
  presentationDiagnostic,
  safePresentationValue,
  toolResultToPresentationText,
  type PresentationSource
} from './translate/pi-tools.js'
import { toToolCallLocations, toToolKind } from './translate/tool-metadata.js'
import { usageUpdateFromPiUsageTelemetry, type PiUsageTelemetry } from './usage.js'

type EmitSessionUpdate = (update: SessionUpdate) => void

type WorkflowUsageTelemetry = {
  sessionId?: string
  contextSessionId?: string
  usage: PiUsageTelemetry
  workflow: WorkflowMeta
  rawPayload: Record<string, unknown>
}

export type WorkflowEventMonitorTarget = {
  workflowId: string
  commandName?: string
  initialTaskMessage?: string
  parentSessionId?: string
}

export type WorkflowEventMonitorAttachTarget = {
  runId?: string
  runDir?: string
  sinceSequence?: number
  replay?: boolean
  includeTerminalFallback?: boolean
}

type WorkflowEventMonitorOptions = {
  workflowRunsDir?: string
  pollIntervalMs?: number
  graceMs?: number
  runEndMaxWaitMs?: number
  target?: WorkflowEventMonitorTarget | null
  attach?: WorkflowEventMonitorAttachTarget | null
  onRecord?: (record: Record<string, unknown>, sequence: number) => void
  onUsageTelemetry?: (event: WorkflowUsageTelemetry) => void
}

type WorkflowEventSourceIdentity = {
  sourceKey: string
  startOffset: number
  endOffset: number
}

type WorkflowEventIdentity =
  | { kind: 'source'; identity: WorkflowEventSourceIdentity }
  | { kind: 'fallback'; key: string }

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
  bufferStartOffset: number
  decoder: StringDecoder
  dev?: number
  ino?: number
  generation: number
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
  childSessionPath?: string
  source?: WorkflowEventSourceIdentity
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

type EditSnapshot = {
  path: string
  oldText?: string
  skippedReason?: string
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
  private readonly sourceIdentities = new SourcePositionDedupe(64)
  private readonly fallbackIdentities = new BoundedIdentitySet(4_096)
  private readonly runs = new Set<string>()
  private readonly endedRuns = new Set<string>()
  private readonly steps = new Map<string, StepPlan>()
  private readonly childTools = new Set<string>()
  private readonly childToolMetadata = new Map<string, ChildToolMetadata>()
  private readonly editSnapshots = new Map<string, EditSnapshot>()
  private readonly emittedChildTextMessages = new Set<string>()
  private readonly pendingNoIdMessageEndSuppressions = new Set<string>()
  private readonly noIdMessageSequences = new Map<string, number>()

  constructor(cwd: string) {
    this.cwd = cwd
  }

  map(record: unknown, sourceIdentity?: WorkflowEventSourceIdentity): SessionUpdate[] {
    return this.mapRecord(record, sourceIdentity).updates
  }

  mapRecord(
    record: unknown,
    sourceIdentity?: WorkflowEventSourceIdentity
  ): { updates: SessionUpdate[]; usageTelemetry?: WorkflowUsageTelemetry } {
    if (!isObject(record)) return { updates: [] }
    const type = stringField(record.type)
    const runId = stringField(record.runId)
    if (!type || !runId) return { updates: [] }

    const identity = eventDedupeIdentity(record, sourceIdentity)
    if (identity && !this.acceptIdentity(identity)) return { updates: [] }

    switch (type) {
      case 'run_start':
        return { updates: this.mapRunStart(record, runId) }
      case 'run_end':
        return { updates: this.mapRunEnd(record, runId) }
      case 'run_interrupted':
      case 'run_paused':
      case 'run_resume_requested':
        return { updates: this.mapRunControl(record, runId, type) }
      case 'step_start':
      case 'step_update':
      case 'step_end':
        return { updates: this.mapStep(record, runId, type) }
      case 'inline_subworkflow_start':
        return { updates: this.mapStep({ ...record, stepType: 'workflow', status: 'running' }, runId, 'step_start') }
      case 'inline_subworkflow_end':
        return {
          updates: this.mapStep(
            { ...record, stepType: 'workflow', status: stringField(record.status) ?? 'completed' },
            runId,
            'step_end'
          )
        }
      case 'subworkflow_call_start':
      case 'subworkflow_call_end':
        return { updates: this.mapSubWorkflowCall(record, runId, type) }
      case 'child_pi_event':
        return { updates: this.mapChildPiEvent(record, runId, sourceIdentity) }
      case 'context_usage_update':
        return this.mapContextUsageUpdate(record, sourceIdentity)
      default:
        return { updates: [] }
    }
  }

  private acceptIdentity(identity: WorkflowEventIdentity): boolean {
    if (identity.kind === 'source') return this.sourceIdentities.accept(identity.identity)
    return this.fallbackIdentities.add(identity.key)
  }

  private mapRunStart(record: Record<string, unknown>, runId: string): SessionUpdate[] {
    if (this.runs.has(runId)) return []
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
    if (this.endedRuns.has(runId)) return []
    this.endedRuns.add(runId)
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

  private mapRunControl(record: Record<string, unknown>, runId: string, type: string): SessionUpdate[] {
    const workflowId = stringField(record.workflowId) ?? 'workflow'
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
    const statusText =
      type === 'run_resume_requested' ? 'resume requested' : type === 'run_paused' ? 'paused' : 'interrupted'
    updates.push(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: workflowToolId(runId),
        status: 'in_progress',
        rawOutput: withWorkflowMeta(
          { status: stringField(record.status), reason: stringField(record.reason), event: type },
          meta
        ),
        _meta: { piWorkflow: meta }
      },
      {
        sessionUpdate: 'session_info_update',
        _meta: { piWorkflow: meta, piAcp: { workflowRunId: runId, workflowStatus: stringField(record.status) } }
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Workflow ${workflowId} ${statusText}.` } satisfies ContentBlock,
        _meta: { piWorkflow: meta }
      }
    )
    return updates
  }

  private mapStep(record: Record<string, unknown>, runId: string, type: string): SessionUpdate[] {
    const stepId = stringField(record.stepId)
    if (!stepId) return []

    const toolCallId = stepToolId(runId, stepId)
    const stepContent = stepTitle(record, stepId)
    const next = { id: toolCallId, content: stepContent, status: planStatus(record, type) }
    const existing = this.steps.get(toolCallId)
    if (existing && existing.content === next.content && existing.status === next.status) return []
    this.steps.set(toolCallId, next)

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
    const next = {
      id: toolCallId,
      content: subWorkflowCallTitle(record, childWorkflowId, toolName, existing?.content),
      status: type === 'subworkflow_call_end' ? 'completed' : 'in_progress'
    } satisfies StepPlan
    if (existing && existing.content === next.content && existing.status === next.status) return []
    this.steps.set(toolCallId, next)

    const plan = this.planUpdate()
    return plan ? [plan] : []
  }

  private mapContextUsageUpdate(
    record: Record<string, unknown>,
    sourceIdentity?: WorkflowEventSourceIdentity
  ): { updates: SessionUpdate[]; usageTelemetry?: WorkflowUsageTelemetry } {
    const usage = piUsageTelemetryFromWorkflowRecord(record)
    if (!usage) return { updates: [] }
    const meta = metaFromRecord(record, sourceIdentity)
    const update = usageUpdateFromPiUsageTelemetry(usage)
    return {
      updates: update ? [{ ...update, _meta: { piWorkflow: meta } } as SessionUpdate] : [],
      usageTelemetry: {
        sessionId: stringField(record.parentSessionId),
        contextSessionId: stringField(record.childSessionId),
        usage,
        workflow: meta,
        rawPayload: record
      }
    }
  }

  private mapChildPiEvent(
    record: Record<string, unknown>,
    runId: string,
    sourceIdentity?: WorkflowEventSourceIdentity
  ): SessionUpdate[] {
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
    const meta = metaFromRecord(record, sourceIdentity)
    const source = workflowToolSource(toolCallId, childType, meta)
    const locations = toToolCallLocations(args, this.cwd)
    const updates: SessionUpdate[] = []

    if (childType === 'tool_execution_start') {
      if (this.childTools.has(toolCallId)) return []
      const metadata = { title: toolName, kind: toToolKind(toolName) }
      this.captureEditSnapshot(toolCallId, toolName, args)
      this.childTools.add(toolCallId)
      this.childToolMetadata.set(toolCallId, metadata)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: metadata.title,
        kind: metadata.kind,
        status: 'in_progress',
        locations,
        rawInput: withWorkflowMeta(safePresentationValue(args, source), meta),
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
        rawInput: withWorkflowMeta(safePresentationValue(args, source), meta),
        _meta: { piWorkflow: meta }
      })
    }

    const text = toolResultToPresentationText(result, source)
    const content =
      childType === 'tool_execution_end'
        ? this.toolEndContent(toolCallId, Boolean(event.isError), text, source)
        : text
          ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
          : undefined
    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      ...(metadata ? { title: metadata.title, kind: metadata.kind } : {}),
      status: childType === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'in_progress',
      content,
      rawOutput: withWorkflowMeta(safePresentationValue(result, source), meta),
      _meta: { piWorkflow: meta }
    })
    if (childType === 'tool_execution_end') {
      this.childToolMetadata.delete(toolCallId)
      this.editSnapshots.delete(toolCallId)
    }
    return updates
  }

  private captureEditSnapshot(toolCallId: string, toolName: string, args: unknown): void {
    if (toolName !== 'edit' || !isObject(args)) return
    const targetPath = stringField(args.path)
    if (!targetPath) return
    try {
      const absolutePath = isAbsolute(targetPath) ? targetPath : resolve(this.cwd, targetPath)
      const stat = statSync(absolutePath)
      if (stat.size <= TOOL_PRESENTATION_LIMITS.diffFileBytes) {
        this.editSnapshots.set(toolCallId, { path: targetPath, oldText: readFileSync(absolutePath, 'utf8') })
      } else {
        this.editSnapshots.set(toolCallId, {
          path: targetPath,
          skippedReason: `structured diff omitted because pre-edit file is ${stat.size} bytes`
        })
      }
    } catch {
      this.editSnapshots.delete(toolCallId)
    }
  }

  private toolEndContent(
    toolCallId: string,
    isError: boolean,
    text: string,
    source: PresentationSource
  ): ToolCallContent[] | undefined {
    const textContent = text ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]) : []
    if (isError) return textContent.length ? textContent : undefined

    const snapshot = this.editSnapshots.get(toolCallId)
    if (!snapshot) return textContent.length ? textContent : undefined
    if (snapshot.skippedReason) {
      return [
        {
          type: 'content',
          content: { type: 'text', text: presentationDiagnostic(snapshot.skippedReason, source) }
        },
        ...textContent
      ]
    }
    if (snapshot.oldText === undefined) return textContent.length ? textContent : undefined

    try {
      const absolutePath = isAbsolute(snapshot.path) ? snapshot.path : resolve(this.cwd, snapshot.path)
      const stat = statSync(absolutePath)
      if (stat.size > TOOL_PRESENTATION_LIMITS.diffFileBytes) {
        return [
          {
            type: 'content',
            content: {
              type: 'text',
              text: presentationDiagnostic(
                `structured diff omitted because post-edit file is ${stat.size} bytes`,
                source
              )
            }
          },
          ...textContent
        ]
      }
      const newText = readFileSync(absolutePath, 'utf8')
      if (newText === snapshot.oldText) return textContent.length ? textContent : undefined
      return [{ type: 'diff', path: snapshot.path, oldText: snapshot.oldText, newText }, ...textContent]
    } catch {
      return textContent.length ? textContent : undefined
    }
  }

  private mapChildMessageUpdate(
    record: Record<string, unknown>,
    runId: string,
    stepId: string,
    event: Record<string, unknown>
  ): SessionUpdate[] {
    const assistantMessageEvent = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined
    if (!assistantMessageEvent) return []

    const meta = metaFromRecord(record)

    if (assistantMessageEvent.type === 'text_start') {
      this.advancePendingNoIdMessageEndSuppression(runId, stepId, meta.childSessionId)
      return []
    }

    if (assistantMessageEvent.type === 'text_delta') return []

    if (assistantMessageEvent.type === 'text_end') {
      const text = stringField(assistantMessageEvent.content)
      return text
        ? this.mapChildFinalAssistantText(record, runId, stepId, event, text, {
            assistantMessageEvent,
            suppressFollowingNoIdMessageEnd: true
          })
        : []
    }

    if (assistantMessageEvent.type === 'thinking_delta') {
      const delta = stringField(assistantMessageEvent.delta)
      return delta
        ? [
            {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: delta } satisfies ContentBlock,
              _meta: { piWorkflow: meta }
            }
          ]
        : []
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

    return this.mapChildFinalAssistantText(record, runId, stepId, event, text)
  }

  private mapChildFinalAssistantText(
    record: Record<string, unknown>,
    runId: string,
    stepId: string,
    event: Record<string, unknown>,
    text: string,
    opts: { assistantMessageEvent?: Record<string, unknown>; suppressFollowingNoIdMessageEnd?: boolean } = {}
  ): SessionUpdate[] {
    const meta = metaFromRecord(record)
    const identity = this.childMessageIdentity(runId, stepId, meta.childSessionId, event, opts.assistantMessageEvent)

    if (this.emittedChildTextMessages.has(identity.sourceKey)) {
      this.resolvePendingNoIdMessageEndSuppression(identity, runId, stepId, meta.childSessionId)
      return []
    }

    const pendingNoIdIdentity = this.currentNoIdChildMessageIdentity(runId, stepId, meta.childSessionId)
    if (this.pendingNoIdMessageEndSuppressions.has(pendingNoIdIdentity.sourceKey)) {
      this.pendingNoIdMessageEndSuppressions.delete(pendingNoIdIdentity.sourceKey)
      this.advanceNoIdChildMessageSequence(runId, stepId, meta.childSessionId)
      return []
    }

    this.emittedChildTextMessages.add(identity.sourceKey)
    if (!identity.hasExplicitId) {
      if (opts.suppressFollowingNoIdMessageEnd) this.pendingNoIdMessageEndSuppressions.add(identity.sourceKey)
      else this.advanceNoIdChildMessageSequence(runId, stepId, meta.childSessionId)
    }

    return [
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: stableUuid(identity.sourceKey),
        content: { type: 'text', text } satisfies ContentBlock,
        _meta: { piWorkflow: meta }
      }
    ]
  }

  private resolvePendingNoIdMessageEndSuppression(
    identity: ChildMessageIdentity,
    runId: string,
    stepId: string,
    childSessionId: string | undefined
  ): void {
    if (identity.hasExplicitId || !this.pendingNoIdMessageEndSuppressions.delete(identity.sourceKey)) return
    this.advanceNoIdChildMessageSequence(runId, stepId, childSessionId)
  }

  private advancePendingNoIdMessageEndSuppression(
    runId: string,
    stepId: string,
    childSessionId: string | undefined
  ): void {
    const identity = this.currentNoIdChildMessageIdentity(runId, stepId, childSessionId)
    if (!this.pendingNoIdMessageEndSuppressions.delete(identity.sourceKey)) return
    this.advanceNoIdChildMessageSequence(runId, stepId, childSessionId)
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
  private readonly attach: WorkflowEventMonitorAttachTarget | null
  private readonly cwdKey: string
  private readonly onRecord?: (record: Record<string, unknown>, sequence: number) => void
  private readonly onUsageTelemetry?: (event: WorkflowUsageTelemetry) => void
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
  private acceptedRunDirPath: string | null = null
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
    this.attach = options.attach ?? null
    this.cwdKey = cwdComparableKey(cwd)
    this.onRecord = options.onRecord
    this.onUsageTelemetry = options.onUsageTelemetry
  }

  start(): void {
    this.snapshotKnownDirs()
    this.attachKnownRun()
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

  private attachKnownRun(): void {
    if (!this.attach || this.acceptedRunDir) return
    const runDir = resolveAttachRunDir(this.workflowRunsDir, this.attach)
    if (!runDir) return
    this.acceptRunDir(this.attach.runId ?? runDir.split(sep).pop() ?? runDir, runDir, {
      sinceSequence: this.attach.sinceSequence,
      replay: this.attach.replay ?? true,
      includeTerminalFallback: this.attach.includeTerminalFallback
    })
  }

  private tick(): void {
    this.discoverRuns()
    this.ingestion.maxActiveTails = Math.max(
      this.ingestion.maxActiveTails,
      Array.from(this.tails.values()).filter(tail => !tail.ended).length
    )
    for (const tail of this.tails.values()) this.readTail(tail)
    this.syncAcceptedRunJsonTerminalState()
    this.maybeFinishAttachedRun()
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

  private acceptRunDir(
    dir: string,
    runDir: string,
    options: { sinceSequence?: number; replay?: boolean; includeTerminalFallback?: boolean } = { replay: false }
  ): void {
    this.acceptedRunDir = dir
    this.acceptedRunDirPath = runDir
    const eventsPath = join(runDir, 'events.jsonl')
    const tail = createTail(eventsPath)
    this.tails.set(eventsPath, tail)
    if (options.replay !== true) return
    this.replayTail(tail, runDir, options.sinceSequence, options.includeTerminalFallback ?? true)
  }

  private replayTail(
    tail: TailState,
    runDir: string,
    sinceSequence: number | undefined,
    includeTerminalFallback: boolean
  ): void {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(tail.filePath)
      if (!stat.isFile()) return
    } catch {
      return
    }

    tail.dev = stat.dev
    tail.ino = stat.ino
    tail.offset = stat.size
    tail.buffer = ''
    tail.bufferStartOffset = stat.size
    let sawRunEnd = false
    let maxSequence = 0

    scanJsonlFile(tail.filePath, 0, stat.size, {
      onLine: (line, lineStart, lineNextOffset) => {
        const trimmed = line.toString('utf8').trim()
        if (!trimmed) return true
        let record: unknown
        try {
          record = JSON.parse(trimmed)
        } catch {
          this.ingestion.malformedLines += 1
          return true
        }
        if (isObject(record)) {
          this.ingestion.recordsObserved += 1
          if (record.type === 'run_end') sawRunEnd = true
          const sequence = nonNegativeInt(record.sequence)
          if (sequence !== undefined) maxSequence = Math.max(maxSequence, sequence)
          if (sinceSequence !== undefined && (sequence === undefined || sequence <= sinceSequence)) return true
          this.onRecord?.(record, this.ingestion.recordsObserved - 1)
          this.acceptLinkedSubWorkflowRun(record)
        }
        const sourceIdentity = {
          sourceKey: tailSourceKey(tail),
          startOffset: lineStart,
          endOffset: lineNextOffset
        }
        const mapped = this.mapper.mapRecord(record, sourceIdentity)
        for (const update of mapped.updates) this.emit(update)
        if (mapped.usageTelemetry) this.onUsageTelemetry?.(mapped.usageTelemetry)
        if (isObject(record) && record.type === 'run_end') tail.ended = true
        return true
      },
      onRemainder: (remainder, remainderStartOffset) => {
        tail.bufferStartOffset = remainderStartOffset
        tail.buffer = tail.decoder.write(remainder)
        this.ingestion.maxTailBufferBytes = Math.max(this.ingestion.maxTailBufferBytes, Buffer.byteLength(tail.buffer))
      }
    })

    if (!includeTerminalFallback || sawRunEnd || tail.ended) return
    const record = readTerminalRunEndRecord(runDir, this.acceptedRunDir ?? runDir, maxSequence + 1)
    if (!record) return
    const sequence = nonNegativeInt(record.sequence)
    if (sinceSequence !== undefined && sequence !== undefined && sequence <= sinceSequence) return
    this.ingestion.recordsObserved += 1
    this.onRecord?.(record, this.ingestion.recordsObserved - 1)
    const mapped = this.mapper.mapRecord(record)
    for (const update of mapped.updates) this.emit(update)
    if (mapped.usageTelemetry) this.onUsageTelemetry?.(mapped.usageTelemetry)
    tail.ended = true
  }

  private acceptLinkedSubWorkflowRun(record: Record<string, unknown>): void {
    const type = stringField(record.type)
    if (type !== 'subworkflow_call_start' && type !== 'subworkflow_call_end') return
    const runDir = stringField(record.childRunDir)
    if (!runDir) return
    const resolvedRunDir = resolve(runDir)
    const resolvedRoot = resolve(this.workflowRunsDir)
    if (resolvedRunDir !== resolvedRoot && !resolvedRunDir.startsWith(`${resolvedRoot}${sep}`)) return
    const eventsPath = join(resolvedRunDir, 'events.jsonl')
    if (this.tails.has(eventsPath)) return
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
    let previousOffset = tail.offset
    try {
      const stat = statSync(tail.filePath)
      if (!stat.isFile()) return
      if (tailIdentityChanged(tail, stat.dev, stat.ino) || stat.size < tail.offset) resetTail(tail)
      tail.dev = stat.dev
      tail.ino = stat.ino
      if (stat.size === tail.offset) return
      previousOffset = tail.offset
      const read = readFileRange(tail.filePath, previousOffset, stat.size, tail.decoder)
      if (!read || read.bytesRead <= 0) return
      text = read.text
      this.ingestion.fileBytesRead += read.bytesRead
      this.ingestion.newBytesObserved += read.bytesRead
      tail.offset = previousOffset + read.bytesRead
    } catch {
      return
    }

    const parsedLines = consumeTailText(tail.buffer, tail.bufferStartOffset, text, previousOffset)
    tail.buffer = parsedLines.buffer
    tail.bufferStartOffset = parsedLines.bufferStartOffset
    this.ingestion.maxTailBufferBytes = Math.max(this.ingestion.maxTailBufferBytes, Buffer.byteLength(tail.buffer))
    for (const line of parsedLines.lines) {
      const trimmed = line.text.trim()
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
      if (isObject(record)) this.acceptLinkedSubWorkflowRun(record)
      const sourceIdentity = {
        sourceKey: tailSourceKey(tail),
        startOffset: line.startOffset,
        endOffset: line.endOffset
      }
      const mapped = this.mapper.mapRecord(record, sourceIdentity)
      for (const update of mapped.updates) this.emit(update)
      if (mapped.usageTelemetry) this.onUsageTelemetry?.(mapped.usageTelemetry)
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

    const runDir = this.acceptedRunDirPath ?? join(this.workflowRunsDir, this.acceptedRunDir)
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

    const mapped = this.mapper.mapRecord(record)
    for (const update of mapped.updates) this.emit(update)
    if (mapped.usageTelemetry) this.onUsageTelemetry?.(mapped.usageTelemetry)
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
    const runDir = this.acceptedRunDirPath ?? join(this.workflowRunsDir, this.acceptedRunDir)
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
    const mapped = this.mapper.mapRecord(fallbackRecord)
    for (const update of mapped.updates) this.emit(update)
    if (mapped.usageTelemetry) this.onUsageTelemetry?.(mapped.usageTelemetry)
    for (const tail of this.tails.values()) tail.ended = true
  }

  private maybeFinishAttachedRun(): void {
    if (!this.attach || this.tails.size === 0) return
    if (Array.from(this.tails.values()).every(tail => tail.ended)) this.dispose()
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
  return {
    filePath,
    offset: 0,
    buffer: '',
    bufferStartOffset: 0,
    decoder: new StringDecoder('utf8'),
    generation: 0,
    ended: false
  }
}

function resetTail(tail: TailState): void {
  tail.offset = 0
  tail.buffer = ''
  tail.bufferStartOffset = 0
  tail.decoder = new StringDecoder('utf8')
  tail.generation += 1
}

function tailIdentityChanged(tail: TailState, dev: number, ino: number): boolean {
  return tail.dev !== undefined && tail.ino !== undefined && (tail.dev !== dev || tail.ino !== ino)
}

function tailSourceKey(tail: TailState): string {
  return compactParts(['events-jsonl', tail.filePath, tail.dev, tail.ino, tail.generation])
}

type ConsumedTailLine = {
  text: string
  startOffset: number
  endOffset: number
}

function consumeTailText(
  buffer: string,
  bufferStartOffset: number,
  text: string,
  textStartOffset: number
): { lines: ConsumedTailLine[]; buffer: string; bufferStartOffset: number } {
  const combined = buffer ? buffer + text : text
  const lines: ConsumedTailLine[] = []
  let cursor = 0
  let lineStartOffset = buffer ? bufferStartOffset : textStartOffset

  for (let index = 0; index < combined.length; index += 1) {
    if (combined.charCodeAt(index) !== 10) continue
    const rawEnd = index + 1
    const textEnd = index > cursor && combined.charCodeAt(index - 1) === 13 ? index - 1 : index
    const rawLine = combined.slice(cursor, rawEnd)
    const endOffset = lineStartOffset + Buffer.byteLength(rawLine)
    lines.push({ text: combined.slice(cursor, textEnd), startOffset: lineStartOffset, endOffset })
    cursor = rawEnd
    lineStartOffset = endOffset
  }

  return { lines, buffer: combined.slice(cursor), bufferStartOffset: lineStartOffset }
}

function activeTailOffsetsKey(tails: TailState[]): string {
  return tails.map(tail => `${tail.filePath}:${tail.offset}:${Buffer.byteLength(tail.buffer)}`).join('|')
}

function terminalRunJsonFallbackRecordKey(record: Record<string, unknown>): string {
  return compactParts([
    'terminal-run-json',
    stringField(record.runId),
    stringField(record.workflowId),
    stringField(record.status),
    stringField(record.auditPath),
    stringField(record.error)
  ])
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

function scanJsonlFile(
  filePath: string,
  startOffset: number,
  endOffset: number,
  handlers: {
    onLine: (line: Buffer, lineStartOffset: number, lineNextOffset: number) => boolean
    onRemainder?: (remainder: Buffer, remainderStartOffset: number) => void
  }
): void {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return
  }
  try {
    const readBuffer = Buffer.allocUnsafe(Math.min(TAIL_READ_CHUNK_BYTES, Math.max(1, endOffset - startOffset)))
    let readOffset = startOffset
    let pending = Buffer.alloc(0)
    let pendingStartOffset = startOffset

    while (readOffset < endOffset) {
      const bytesRead = readSync(fd, readBuffer, 0, Math.min(readBuffer.byteLength, endOffset - readOffset), readOffset)
      if (bytesRead <= 0) break
      const chunk = readBuffer.subarray(0, bytesRead)
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const dataStartOffset = pending.length ? pendingStartOffset : readOffset
      readOffset += bytesRead

      let cursor = 0
      while (cursor < data.length) {
        const newlineIndex = data.indexOf(0x0a, cursor)
        if (newlineIndex === -1) break
        let contentEnd = newlineIndex
        if (contentEnd > cursor && data[contentEnd - 1] === 0x0d) contentEnd -= 1
        const lineNextOffset = dataStartOffset + newlineIndex + 1
        const shouldContinue = handlers.onLine(
          data.subarray(cursor, contentEnd),
          dataStartOffset + cursor,
          lineNextOffset
        )
        cursor = newlineIndex + 1
        if (!shouldContinue) return
      }

      pending = Buffer.from(data.subarray(cursor))
      pendingStartOffset = dataStartOffset + cursor
    }

    if (pending.length > 0) handlers.onRemainder?.(pending, pendingStartOffset)
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

function resolveAttachRunDir(workflowRunsDir: string, attach: WorkflowEventMonitorAttachTarget): string | null {
  if (attach.runDir) return resolve(attach.runDir)
  if (!attach.runId) return null
  return join(workflowRunsDir, attach.runId)
}

function readWorkflowRunMetadata(runDir: string): WorkflowRunMetadata | null {
  const runJson = readJsonObject(join(runDir, 'run.json'))
  if (runJson) return metadataFromRunJson(runJson, runDir)
  return readMetadataFromEvents(join(runDir, 'events.jsonl'))
}

function readTerminalRunEndRecord(
  runDir: string,
  fallbackRunId: string,
  sequence?: number
): Record<string, unknown> | null {
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
    error: stringField(runJson.error),
    ...(sequence !== undefined ? { sequence, eventId: `${metadata.runId ?? fallbackRunId}:run_end:run-json` } : {})
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

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function hasOwnKeys(value: object): boolean {
  return Object.keys(value).length > 0
}

function usageTokenDetails(
  value: Record<string, unknown> | undefined
): NonNullable<PiUsageTelemetry['lastRequest']> | undefined {
  if (!value) return undefined
  const details = {
    ...(nonNegativeInt(value.totalTokens ?? value.total) !== undefined
      ? { totalTokens: nonNegativeInt(value.totalTokens ?? value.total)! }
      : {}),
    ...(nonNegativeInt(value.inputTokens ?? value.input) !== undefined
      ? { inputTokens: nonNegativeInt(value.inputTokens ?? value.input)! }
      : {}),
    ...(nonNegativeInt(value.outputTokens ?? value.output) !== undefined
      ? { outputTokens: nonNegativeInt(value.outputTokens ?? value.output)! }
      : {}),
    ...(nonNegativeInt(value.reasoningTokens ?? value.thoughtTokens ?? value.thought ?? value.reasoning) !== undefined
      ? {
          reasoningTokens: nonNegativeInt(
            value.reasoningTokens ?? value.thoughtTokens ?? value.thought ?? value.reasoning
          )!
        }
      : {}),
    ...(nonNegativeInt(value.cachedReadTokens ?? value.cacheRead) !== undefined
      ? { cachedReadTokens: nonNegativeInt(value.cachedReadTokens ?? value.cacheRead)! }
      : {}),
    ...(nonNegativeInt(value.cachedWriteTokens ?? value.cacheWrite) !== undefined
      ? { cachedWriteTokens: nonNegativeInt(value.cachedWriteTokens ?? value.cacheWrite)! }
      : {})
  }
  return hasOwnKeys(details) ? details : undefined
}

function piUsageTelemetryFromWorkflowRecord(record: Record<string, unknown>): PiUsageTelemetry | undefined {
  const rawUsage = isObject(record.usage) ? record.usage : undefined
  if (!rawUsage) return undefined

  const rawContext = isObject(rawUsage.context) ? rawUsage.context : undefined
  const rawTotals = isObject(rawUsage.totals) ? rawUsage.totals : undefined
  const rawLastRequest = isObject(rawUsage.lastRequest) ? rawUsage.lastRequest : undefined
  const rawCost = isObject(rawUsage.cost) ? rawUsage.cost : undefined
  const rawModel = isObject(rawUsage.model) ? rawUsage.model : undefined
  const rawCache = isObject(rawUsage.cache) ? rawUsage.cache : undefined
  const rawAutoCompaction = isObject(rawUsage.autoCompaction) ? rawUsage.autoCompaction : undefined

  const usedTokens = nonNegativeInt(rawContext?.usedTokens)
  const maxTokens = positiveInt(rawContext?.maxTokens)
  const context =
    usedTokens !== undefined || maxTokens !== undefined
      ? {
          ...(usedTokens !== undefined ? { usedTokens } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {})
        }
      : undefined
  const totals = usageTokenDetails(rawTotals)
  const lastRequest = usageTokenDetails(rawLastRequest)
  const amount = finiteNonNegativeNumber(rawCost?.amount)
  const currency = stringField(rawCost?.currency) ?? (amount !== undefined ? 'USD' : undefined)
  const model = {
    ...(stringField(rawModel?.name) ? { name: stringField(rawModel?.name) } : {}),
    ...(stringField(rawModel?.provider) ? { provider: stringField(rawModel?.provider) } : {}),
    ...(stringField(rawModel?.effort) ? { effort: stringField(rawModel?.effort) } : {})
  }
  const cache = {
    ...(stringField(rawCache?.status) ? { status: stringField(rawCache?.status) } : {})
  }
  const autoCompactionEnabled = typeof rawAutoCompaction?.enabled === 'boolean' ? rawAutoCompaction.enabled : undefined
  const usage = {
    ...(context ? { context } : {}),
    ...(totals ? { totals } : {}),
    ...(lastRequest ? { lastRequest } : {}),
    ...(amount !== undefined && currency ? { cost: { amount, currency } } : {}),
    ...(hasOwnKeys(model) ? { model } : {}),
    ...(hasOwnKeys(cache) ? { cache } : {}),
    ...(autoCompactionEnabled !== undefined ? { autoCompaction: { enabled: autoCompactionEnabled } } : {})
  } satisfies PiUsageTelemetry

  return hasOwnKeys(usage) ? usage : undefined
}

function eventDedupeIdentity(
  record: Record<string, unknown>,
  sourceIdentity: WorkflowEventSourceIdentity | undefined
): WorkflowEventIdentity | null {
  if (sourceIdentity) return { kind: 'source', identity: sourceIdentity }
  const key = compactEventIdentity(record)
  return key ? { kind: 'fallback', key } : null
}

function compactEventIdentity(record: Record<string, unknown>): string | null {
  const type = stringField(record.type)
  const runId = stringField(record.runId)
  if (!type || !runId) return null

  const sequence = primitiveIdentityPart(record.sequence)
  if (sequence) return compactParts(['run', runId, 'sequence', sequence])

  switch (type) {
    case 'run_start':
    case 'run_end':
      return compactParts(['run', runId, type])
    case 'step_start':
    case 'step_update':
    case 'step_end':
    case 'inline_subworkflow_start':
    case 'inline_subworkflow_end':
      return compactParts([
        type,
        runId,
        stringField(record.stepId),
        stringField(record.status),
        stringField(record.stepType)
      ])
    case 'subworkflow_call_start':
    case 'subworkflow_call_end':
      return compactParts([
        type,
        runId,
        stringField(record.stepId),
        stringField(record.toolName),
        stringField(record.startedAt),
        stringField(record.status),
        stringField(record.childWorkflowId),
        stringField(record.workflowId),
        stringField(record.task)
      ])
    case 'child_pi_event':
      return compactChildEventIdentity(record, runId)
    default:
      return compactParts([type, runId, primitiveIdentityPart(record.timestamp), jsonHash(record)])
  }
}

function compactChildEventIdentity(record: Record<string, unknown>, runId: string): string | null {
  const event = isObject(record.event) ? record.event : undefined
  const childType = stringField(record.childEventType)
  const stepId = stringField(record.stepId)
  if (!event || !childType || !stepId) return null

  const base = ['child', runId, stepId, stringField(record.childSessionId), childType]
  if (childType.startsWith('tool_execution_')) {
    const toolCallId = stringField(event.toolCallId)
    if (!toolCallId) return null
    if (childType === 'tool_execution_update') {
      return compactParts([...base, toolCallId, primitiveIdentityPart(record.timestamp), jsonHash(event.partialResult)])
    }
    return compactParts([...base, toolCallId])
  }

  if (childType === 'message_update') {
    const assistantMessageEvent = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined
    return compactParts([
      ...base,
      childMessageExplicitId(event, assistantMessageEvent),
      stringField(assistantMessageEvent?.type),
      primitiveIdentityPart(record.timestamp),
      jsonHash(assistantMessageEvent)
    ])
  }

  if (childType === 'message_end') {
    const message = isObject(event.message) ? event.message : undefined
    return compactParts([
      ...base,
      childMessageExplicitId(event),
      primitiveIdentityPart(record.timestamp),
      jsonHash(message)
    ])
  }

  return compactParts([...base, primitiveIdentityPart(record.timestamp), jsonHash(event)])
}

function primitiveIdentityPart(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

function compactParts(parts: Array<string | number | undefined>): string {
  return parts.map(part => encodeURIComponent(String(part ?? ''))).join(':')
}

function jsonHash(value: unknown): string {
  return createHash('sha1').update(stableJson(value)).digest('hex').slice(0, 16)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

class BoundedIdentitySet {
  private readonly keys = new Set<string>()

  constructor(private readonly maxSize: number) {}

  add(key: string): boolean {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    while (this.keys.size > this.maxSize) {
      const oldest = this.keys.values().next().value as string | undefined
      if (oldest === undefined) break
      this.keys.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.keys.size
  }
}

class SourcePositionDedupe {
  private readonly sources = new Map<string, number>()

  constructor(private readonly maxSources: number) {}

  accept(identity: WorkflowEventSourceIdentity): boolean {
    const previousEnd = this.sources.get(identity.sourceKey)
    if (previousEnd !== undefined && identity.endOffset <= previousEnd) return false
    if (previousEnd !== undefined) this.sources.delete(identity.sourceKey)
    this.sources.set(identity.sourceKey, Math.max(previousEnd ?? 0, identity.endOffset))
    while (this.sources.size > this.maxSources) {
      const oldest = this.sources.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.sources.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.sources.size
  }
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

function metaFromRecord(record: Record<string, unknown>, source?: WorkflowEventSourceIdentity): WorkflowMeta {
  return {
    runId: String(record.runId),
    workflowId: stringField(record.workflowId),
    commandName: stringField(record.commandName),
    runDir: stringField(record.runDir),
    auditPath: stringField(record.auditPath),
    stepId: stringField(record.stepId),
    childSessionId: stringField(record.childSessionId),
    childSessionPath: stringField(record.childSessionPath),
    ...(source ? { source } : {})
  }
}

function workflowToolSource(toolCallId: string, eventType: string, meta: WorkflowMeta): PresentationSource {
  return {
    label: 'workflow child tool event',
    toolCallId,
    eventType,
    workflow: meta
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
