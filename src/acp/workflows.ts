import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { getAgentDir } from './pi-settings.js'

export const PI_WORKFLOWS_LIST_METHOD = '_pi/workflows/list'
export const PI_WORKFLOWS_GET_METHOD = '_pi/workflows/get'
export const PI_WORKFLOWS_EVENTS_METHOD = '_pi/workflows/events'
export const PI_WORKFLOWS_RESUME_METHOD = '_pi/workflows/resume'
export const PI_WORKFLOWS_PAUSE_METHOD = '_pi/workflows/pause'
export const PI_WORKFLOWS_ABORT_METHOD = '_pi/workflows/abort'

export const PI_WORKFLOW_METHODS = [
  PI_WORKFLOWS_LIST_METHOD,
  PI_WORKFLOWS_GET_METHOD,
  PI_WORKFLOWS_EVENTS_METHOD,
  PI_WORKFLOWS_RESUME_METHOD,
  PI_WORKFLOWS_PAUSE_METHOD,
  PI_WORKFLOWS_ABORT_METHOD
] as const

export type WorkflowRunStatus = 'running' | 'paused' | 'interrupted' | 'recovering' | 'completed' | 'failed' | 'aborted'

export type WorkflowRunRecord = Record<string, unknown> & {
  id: string
  cwd: string
  runDir: string
  status: WorkflowRunStatus
  workflowId?: string
  parentSessionId?: string
  parentSessionFile?: string
  startedAt?: string
}

export type WorkflowEventReplayResult = {
  events: Record<string, unknown>[]
  nextOffset: number
  lastSequence?: number
  malformedLineCount: number
  terminalFallback?: Record<string, unknown>
}

export type WorkflowRunListFilters = {
  cwd?: string
  parentSessionId?: string
  status?: WorkflowRunStatus | WorkflowRunStatus[]
  limit?: number
  workflowRunsDir?: string
  includeTerminalFallbackRuns?: boolean
}

export type WorkflowRunControlOptions = {
  reason?: string
  policy?: 'continue-existing-session' | 'redo-step' | 'manual'
  workflowRunsDir?: string
}

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(['completed', 'failed', 'aborted'])
const RECOVERABLE_STATUSES = new Set<WorkflowRunStatus>(['running', 'paused', 'interrupted', 'recovering'])
const WORKFLOW_EVENT_ENVELOPE_VERSION = 1

export function workflowRunsDir(): string {
  return join(getAgentDir(), 'workflow-runs')
}

export function isTerminalWorkflowStatus(status: unknown): status is WorkflowRunStatus {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status as WorkflowRunStatus)
}

export function isRecoverableWorkflowStatus(status: unknown): status is WorkflowRunStatus {
  return typeof status === 'string' && RECOVERABLE_STATUSES.has(status as WorkflowRunStatus)
}

export function listWorkflowRuns(filters: WorkflowRunListFilters = {}): WorkflowRunRecord[] {
  const root = filters.workflowRunsDir ?? workflowRunsDir()
  const statuses = new Set(Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [])
  const runs: WorkflowRunRecord[] = []

  for (const entry of safeReadRunDirs(root)) {
    const run = readWorkflowRunFromDir(join(root, entry))
    if (!run) continue
    if (filters.cwd !== undefined && resolve(run.cwd) !== resolve(filters.cwd)) continue
    if (filters.parentSessionId !== undefined && run.parentSessionId !== filters.parentSessionId) continue
    if (statuses.size > 0 && !statuses.has(run.status)) continue
    if (
      !filters.includeTerminalFallbackRuns ||
      !isTerminalWorkflowStatus(run.status) ||
      workflowRunHasRunEnd(run.runDir)
    ) {
      runs.push(run)
      continue
    }
    runs.push(run)
  }

  runs.sort(
    (left, right) => (Date.parse(String(right.startedAt ?? '')) || 0) - (Date.parse(String(left.startedAt ?? '')) || 0)
  )
  return typeof filters.limit === 'number' && filters.limit >= 0 ? runs.slice(0, filters.limit) : runs
}

export function listRecoverableWorkflowRunsForSession(filters: {
  cwd: string
  parentSessionId: string
  workflowRunsDir?: string
}): WorkflowRunRecord[] {
  return listWorkflowRuns({
    cwd: filters.cwd,
    parentSessionId: filters.parentSessionId,
    workflowRunsDir: filters.workflowRunsDir,
    includeTerminalFallbackRuns: true
  }).filter(
    run =>
      isRecoverableWorkflowStatus(run.status) ||
      (isTerminalWorkflowStatus(run.status) && !workflowRunHasRunEnd(run.runDir))
  )
}

export function readWorkflowRun(target: string, root = workflowRunsDir()): WorkflowRunRecord {
  const runDir = resolveWorkflowRunDir(target, root)
  const run = readWorkflowRunFromDir(runDir)
  if (!run) throw new Error(`Unknown workflow run: ${target}`)
  return run
}

export function readWorkflowRunEvents(
  target: string,
  options: {
    sinceSequence?: number
    offset?: number
    limit?: number
    includeTerminalFallback?: boolean
    workflowRunsDir?: string
  } = {}
): WorkflowEventReplayResult {
  const run = readWorkflowRun(target, options.workflowRunsDir ?? workflowRunsDir())
  const eventsPath = join(run.runDir, 'events.jsonl')
  let buffer: Buffer
  try {
    buffer = readFileSync(eventsPath)
  } catch {
    buffer = Buffer.alloc(0)
  }

  const start = Math.min(Math.max(0, options.offset ?? 0), buffer.length)
  const events: Record<string, unknown>[] = []
  let malformedLineCount = 0
  let lastSequence: number | undefined
  let nextOffset = start
  let sawRunEnd = false
  const sinceSequence = options.sinceSequence
  const limit = options.limit
  let cursor = start

  while (cursor < buffer.length && (limit === undefined || events.length < limit)) {
    const lineStart = cursor
    const newlineIndex = buffer.indexOf(0x0a, cursor)
    const lineEnd = newlineIndex === -1 ? buffer.length : newlineIndex
    const lineNextOffset = newlineIndex === -1 ? buffer.length : newlineIndex + 1
    cursor = lineNextOffset
    nextOffset = lineNextOffset
    let contentEnd = lineEnd
    if (contentEnd > lineStart && buffer[contentEnd - 1] === 0x0d) contentEnd -= 1
    const trimmed = buffer.subarray(lineStart, contentEnd).toString('utf8').trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformedLineCount += 1
      continue
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      malformedLineCount += 1
      continue
    }
    if (parsed.type === 'run_end') sawRunEnd = true
    const sequence = numberField(parsed.sequence)
    if (sequence !== undefined) lastSequence = Math.max(lastSequence ?? 0, sequence)
    if (sinceSequence !== undefined && (sequence === undefined || sequence <= sinceSequence)) continue
    events.push(parsed)
  }

  if (cursor >= buffer.length) nextOffset = buffer.length
  const result: WorkflowEventReplayResult = {
    events,
    nextOffset,
    malformedLineCount,
    ...(lastSequence !== undefined ? { lastSequence } : {})
  }

  if (options.includeTerminalFallback && !sawRunEnd && (limit === undefined || events.length < limit)) {
    const fallback = terminalRunEndRecord(run, (lastSequence ?? maxSequence(events) ?? 0) + 1)
    if (fallback && (sinceSequence === undefined || numberField(fallback.sequence)! > sinceSequence)) {
      result.events.push(fallback)
      result.terminalFallback = fallback
      result.lastSequence = Math.max(result.lastSequence ?? 0, numberField(fallback.sequence) ?? 0)
    }
  }

  return result
}

export function pauseWorkflowRun(target: string, options: WorkflowRunControlOptions = {}): WorkflowRunRecord {
  const run = readWorkflowRun(target, options.workflowRunsDir)
  if (isTerminalWorkflowStatus(run.status)) throw new Error(`Cannot pause terminal workflow run ${run.id}.`)
  const now = new Date().toISOString()
  run.status = 'paused'
  run.control = { ...(isRecord(run.control) ? run.control : {}), pauseRequestedAt: now, reason: options.reason }
  updateActiveSteps(run, 'paused', now, options.reason)
  writeWorkflowRun(run)
  appendControlEvent(run, { type: 'run_paused', status: run.status, reason: options.reason })
  return run
}

export function resumeWorkflowRun(target: string, options: WorkflowRunControlOptions = {}): WorkflowRunRecord {
  const run = readWorkflowRun(target, options.workflowRunsDir)
  if (isTerminalWorkflowStatus(run.status)) throw new Error(`Cannot resume terminal workflow run ${run.id}.`)
  const now = new Date().toISOString()
  run.status = 'recovering'
  run.control = {
    ...(isRecord(run.control) ? run.control : {}),
    resumeRequestedAt: now,
    reason: options.reason,
    policy: options.policy ?? 'continue-existing-session'
  }
  updateActiveSteps(run, 'recovering', now, options.reason)
  writeWorkflowRun(run)
  appendControlEvent(run, {
    type: 'run_resume_requested',
    status: run.status,
    policy: options.policy ?? 'continue-existing-session',
    reason: options.reason
  })
  return run
}

export function abortWorkflowRun(target: string, options: WorkflowRunControlOptions = {}): WorkflowRunRecord {
  const run = readWorkflowRun(target, options.workflowRunsDir)
  if (isTerminalWorkflowStatus(run.status)) return run
  const now = new Date().toISOString()
  const reason = options.reason ?? 'Workflow run aborted.'
  run.status = 'aborted'
  run.endedAt = now
  run.error = reason
  run.control = { ...(isRecord(run.control) ? run.control : {}), abortRequestedAt: now, reason }
  updateActiveSteps(run, 'aborted', now, reason)
  writeWorkflowRun(run)
  appendControlEvent(run, { type: 'run_end', status: run.status, error: reason })
  appendControlEvent(run, { type: 'run_aborted', status: run.status, reason })
  return run
}

export function workflowRunHasRunEnd(runDir: string): boolean {
  try {
    const content = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    return content.split(/\r?\n/).some(line => {
      if (!line.trim()) return false
      try {
        const parsed: unknown = JSON.parse(line)
        return isRecord(parsed) && parsed.type === 'run_end'
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function safeReadRunDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function readWorkflowRunFromDir(runDir: string): WorkflowRunRecord | null {
  const raw = readJsonObject(join(runDir, 'run.json'))
  if (!raw) return null
  const id = stringField(raw.id) ?? basename(runDir)
  const cwd = stringField(raw.cwd)
  const status = stringField(raw.status) as WorkflowRunStatus | undefined
  if (!cwd || !status || ![...TERMINAL_STATUSES, ...RECOVERABLE_STATUSES].includes(status)) return null
  return { ...raw, id, cwd, status, runDir: stringField(raw.runDir) ?? runDir }
}

function resolveWorkflowRunDir(target: string, root: string): string {
  const trimmed = target.trim()
  if (!trimmed) throw new Error('Workflow run target must be non-empty.')
  if (trimmed.includes(sep) || trimmed.includes('/') || trimmed.includes('\\')) return resolve(trimmed)
  return join(root, trimmed)
}

function writeWorkflowRun(run: WorkflowRunRecord): void {
  writeFileSync(join(run.runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

function appendControlEvent(run: WorkflowRunRecord, event: Record<string, unknown>): void {
  const sequence = readMaxSequence(run.runDir) + 1
  const record = withoutUndefined({
    timestamp: new Date().toISOString(),
    runId: run.id,
    rootWorkflowId: stringField(run.rootWorkflowId) ?? stringField(run.workflowId),
    workflowId: stringField(run.workflowId) ?? stringField(run.rootWorkflowId),
    commandName: stringField(run.commandName),
    cwd: run.cwd,
    parentSessionId: stringField(run.parentSessionId),
    parentSessionFile: stringField(run.parentSessionFile),
    runDir: run.runDir,
    auditPath: stringField(run.auditPath),
    ...event,
    workflowEventVersion: WORKFLOW_EVENT_ENVELOPE_VERSION,
    sequence,
    eventId: `${run.id}:${sequence}`
  })
  appendFileSync(join(run.runDir, 'events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

function readMaxSequence(runDir: string): number {
  try {
    return readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      .split(/\r?\n/)
      .reduce((max, line) => {
        if (!line.trim()) return max
        try {
          const parsed: unknown = JSON.parse(line)
          const sequence = isRecord(parsed) ? numberField(parsed.sequence) : undefined
          return sequence !== undefined && sequence > max ? sequence : max
        } catch {
          return max
        }
      }, 0)
  } catch {
    return 0
  }
}

function updateActiveSteps(run: WorkflowRunRecord, status: string, now: string, reason?: string): void {
  if (!Array.isArray(run.steps)) return
  for (const step of run.steps) {
    if (!isRecord(step)) continue
    if (!['running', 'paused', 'interrupted', 'recovering'].includes(String(step.status))) continue
    step.status = status
    step.endedAt = status === 'aborted' || status === 'paused' ? now : step.endedAt
    step.stopReason = status
    if (reason) step.error = reason
  }
}

function terminalRunEndRecord(run: WorkflowRunRecord, sequence: number): Record<string, unknown> | null {
  if (!isTerminalWorkflowStatus(run.status)) return null
  return withoutUndefined({
    type: 'run_end',
    timestamp: stringField(run.endedAt) ?? runJsonMtime(run.runDir),
    runId: run.id,
    rootWorkflowId: stringField(run.rootWorkflowId) ?? stringField(run.workflowId),
    workflowId: stringField(run.workflowId) ?? stringField(run.rootWorkflowId),
    commandName: stringField(run.commandName),
    cwd: run.cwd,
    parentSessionId: stringField(run.parentSessionId),
    parentSessionFile: stringField(run.parentSessionFile),
    runDir: run.runDir,
    auditPath: stringField(run.auditPath),
    status: run.status,
    error: stringField(run.error),
    workflowEventVersion: WORKFLOW_EVENT_ENVELOPE_VERSION,
    sequence,
    eventId: `${run.id}:run_end:run-json`,
    reconciledFrom: 'run.json'
  })
}

function runJsonMtime(runDir: string): string {
  try {
    return statSync(join(runDir, 'run.json')).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function maxSequence(events: Record<string, unknown>[]): number | undefined {
  let max: number | undefined
  for (const event of events) {
    const sequence = numberField(event.sequence)
    if (sequence !== undefined) max = Math.max(max ?? 0, sequence)
  }
  return max
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}
