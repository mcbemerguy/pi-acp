import type { ContentBlock, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getAgentDir } from './pi-settings.js'
import { toolResultToText } from './translate/pi-tools.js'
import { toToolCallLocations, toToolKind } from './translate/tool-metadata.js'

type EmitSessionUpdate = (update: SessionUpdate) => void

type WorkflowEventMonitorOptions = {
  workflowRunsDir?: string
  pollIntervalMs?: number
  graceMs?: number
}

type TailState = {
  filePath: string
  offset: number
  buffer: string
  ended: boolean
}

type WorkflowMeta = {
  runId: string
  workflowId?: string
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

export function isWorkflowCommandPrompt(message: string): boolean {
  return /^\s*\/workflow:[^\s]+(?:\s|$)/.test(message)
}

export class WorkflowEventMapper {
  private readonly cwd: string
  private readonly seen = new Set<string>()
  private readonly runs = new Set<string>()
  private readonly steps = new Map<string, StepPlan>()
  private readonly childTools = new Set<string>()

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

    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: workflowToolId(runId),
      status,
      rawOutput: withWorkflowMeta({ status: stringField(record.status), error: stringField(record.error) }, meta),
      _meta: { piWorkflow: meta }
    })

    const auditPath = stringField(record.auditPath)
    const summary = `Workflow ${workflowId} ${status === 'failed' ? 'failed' : 'completed'}${auditPath ? `. Audit: ${auditPath}` : '.'}`
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

    const status = stepToolStatus(record, type)
    const toolCallId = stepToolId(runId, stepId)
    const meta = metaFromRecord(record)
    const stepContent = stepTitle(record, stepId)
    const hadStep = this.steps.has(toolCallId)
    this.steps.set(toolCallId, { id: toolCallId, content: stepContent, status: planStatus(record, type) })

    const updates: SessionUpdate[] = []
    if (type === 'step_start' || !hadStep) {
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: stepContent,
        kind: 'other',
        status,
        rawInput: withWorkflowMeta(stepRaw(record), meta),
        _meta: { piWorkflow: meta }
      })
    } else {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: stepContent,
        status,
        content: stepUpdateContent(record),
        rawOutput: withWorkflowMeta(stepRaw(record), meta),
        _meta: { piWorkflow: meta }
      })
    }

    const plan = this.planUpdate()
    if (plan) updates.push(plan)
    return updates
  }

  private mapChildPiEvent(record: Record<string, unknown>, runId: string): SessionUpdate[] {
    const childType = stringField(record.childEventType)
    const stepId = stringField(record.stepId)
    const event = isObject(record.event) ? record.event : undefined
    if (!childType || !stepId || !event) return []
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
      this.childTools.add(toolCallId)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName,
        kind: toToolKind(toolName),
        status: 'in_progress',
        locations,
        rawInput: withWorkflowMeta(args, meta),
        _meta: { piWorkflow: meta }
      })
      return updates
    }

    if (!this.childTools.has(toolCallId)) {
      this.childTools.add(toolCallId)
      updates.push({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName,
        kind: toToolKind(toolName),
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
      status: childType === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'in_progress',
      content,
      rawOutput: withWorkflowMeta(result, meta),
      _meta: { piWorkflow: meta }
    })
    return updates
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

export class WorkflowEventMonitor {
  private readonly workflowRunsDir: string
  private readonly pollIntervalMs: number
  private readonly graceMs: number
  private readonly emit: EmitSessionUpdate
  private readonly mapper: WorkflowEventMapper
  private readonly knownDirs = new Set<string>()
  private readonly tails = new Map<string, TailState>()
  private interval: NodeJS.Timeout | null = null
  private stopPromise: Promise<void> | null = null
  private stopResolve: (() => void) | null = null
  private stopRequestedAt: number | null = null

  constructor(cwd: string, emit: EmitSessionUpdate, options: WorkflowEventMonitorOptions = {}) {
    this.workflowRunsDir = options.workflowRunsDir ?? join(getAgentDir(), 'workflow-runs')
    this.pollIntervalMs = options.pollIntervalMs ?? 75
    this.graceMs = options.graceMs ?? 350
    this.emit = emit
    this.mapper = new WorkflowEventMapper(cwd)
  }

  start(): void {
    this.snapshotKnownDirs()
    this.interval = setInterval(() => this.tick(), this.pollIntervalMs)
    this.interval.unref?.()
    this.tick()
  }

  stopAfterPromptResolution(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopRequestedAt = Date.now()
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
    for (const tail of this.tails.values()) this.readTail(tail)
    this.maybeFinish()
  }

  private discoverRuns(): void {
    for (const dir of listRunDirs(this.workflowRunsDir)) {
      if (this.knownDirs.has(dir)) continue
      this.knownDirs.add(dir)
      const eventsPath = join(this.workflowRunsDir, dir, 'events.jsonl')
      this.tails.set(eventsPath, { filePath: eventsPath, offset: 0, buffer: '', ended: false })
    }
  }

  private readTail(tail: TailState): void {
    if (tail.ended) return
    let text = ''
    try {
      if (!existsSync(tail.filePath)) return
      const stat = statSync(tail.filePath)
      if (!stat.isFile()) return
      if (stat.size < tail.offset) {
        tail.offset = 0
        tail.buffer = ''
      }
      if (stat.size === tail.offset) return
      const data = readFileSync(tail.filePath)
      const endOffset = Math.min(stat.size, data.byteLength)
      text = data.subarray(tail.offset, endOffset).toString('utf8')
      tail.offset = endOffset
    } catch {
      return
    }

    const lines = (tail.buffer + text).split(/\r?\n/)
    tail.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let record: unknown
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      for (const update of this.mapper.map(record)) this.emit(update)
      if (isObject(record) && record.type === 'run_end') tail.ended = true
    }
  }

  private maybeFinish(): void {
    if (this.stopRequestedAt === null) return
    const graceElapsed = Date.now() - this.stopRequestedAt >= this.graceMs
    const noActiveTails = Array.from(this.tails.values()).every(tail => tail.ended)
    if (!graceElapsed && !noActiveTails) return
    if (!graceElapsed && this.tails.size === 0) return
    this.dispose()
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

function metaFromRecord(record: Record<string, unknown>): WorkflowMeta {
  return {
    runId: String(record.runId),
    workflowId: stringField(record.workflowId),
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
  return status === 'failed' || status === 'error' || Boolean(record.error)
}

function stepToolStatus(record: Record<string, unknown>, type: string): 'in_progress' | 'completed' | 'failed' {
  if (type === 'step_end') return isFailedStatus(record) ? 'failed' : 'completed'
  return 'in_progress'
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

function stepRaw(record: Record<string, unknown>): Record<string, unknown> {
  return {
    stepId: stringField(record.stepId),
    stepType: stringField(record.stepType),
    status: stringField(record.status),
    activity: stringField(record.activity),
    currentTool: stringField(record.currentTool),
    childSessionId: stringField(record.childSessionId),
    childSessionPath: stringField(record.childSessionPath),
    error: stringField(record.error)
  }
}

function stepUpdateContent(record: Record<string, unknown>): ToolCallContent[] | undefined {
  const parts = [stringField(record.activity), stringField(record.currentTool), stringField(record.childSessionId)]
    .filter(Boolean)
    .join('\n')
  return parts ? [{ type: 'content', content: { type: 'text', text: parts } }] : undefined
}
