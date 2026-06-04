import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { getAgentDir } from './pi-settings.js'

export const PI_WORKFLOWS_LIST_METHOD = '_pi/workflows/list'
export const PI_WORKFLOWS_GET_METHOD = '_pi/workflows/get'
export const PI_WORKFLOWS_EVENTS_METHOD = '_pi/workflows/events'
export const PI_WORKFLOWS_RESUME_METHOD = '_pi/workflows/resume'
export const PI_WORKFLOWS_INTERRUPT_METHOD = '_pi/workflows/interrupt'
export const PI_WORKFLOWS_PAUSE_METHOD = '_pi/workflows/pause'
export const PI_WORKFLOWS_ABORT_METHOD = '_pi/workflows/abort'

export const PI_WORKFLOW_METHODS = [
  PI_WORKFLOWS_LIST_METHOD,
  PI_WORKFLOWS_GET_METHOD,
  PI_WORKFLOWS_EVENTS_METHOD,
  PI_WORKFLOWS_RESUME_METHOD,
  PI_WORKFLOWS_INTERRUPT_METHOD,
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
  continuationMessage?: string
}

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(['completed', 'failed', 'aborted'])
const RECOVERABLE_STATUSES = new Set<WorkflowRunStatus>(['running', 'paused', 'interrupted', 'recovering'])
const WORKFLOW_EVENT_ENVELOPE_VERSION = 1
const EVENT_READ_CHUNK_BYTES = 64 * 1024

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
  const scan = scanWorkflowEventFile(eventsPath, {
    offset: options.offset,
    sinceSequence: options.sinceSequence,
    limit: options.limit
  })
  const result: WorkflowEventReplayResult = {
    events: scan.events,
    nextOffset: scan.nextOffset,
    malformedLineCount: scan.malformedLineCount,
    ...(scan.lastSequence !== undefined ? { lastSequence: scan.lastSequence } : {})
  }

  if (options.includeTerminalFallback && (options.limit === undefined || result.events.length < options.limit)) {
    const stats = scan.startOffset === 0 && scan.reachedEnd ? scan : scanCompleteEventFileStats(eventsPath)
    if (!stats.sawRunEnd) {
      const fallback = terminalRunEndRecord(run, stats.maxSequence + 1)
      if (
        fallback &&
        (options.sinceSequence === undefined || numberField(fallback.sequence)! > options.sinceSequence)
      ) {
        result.events.push(fallback)
        result.terminalFallback = fallback
        result.lastSequence = Math.max(result.lastSequence ?? 0, numberField(fallback.sequence) ?? 0)
      }
    }
  }

  return result
}

export function pauseWorkflowRun(target: string, options: WorkflowRunControlOptions = {}): WorkflowRunRecord {
  const run = readWorkflowRun(target, options.workflowRunsDir)
  if (isTerminalWorkflowStatus(run.status)) throw new Error(`Cannot pause terminal workflow run ${run.id}.`)
  const now = new Date().toISOString()
  run.status = 'paused'
  run.control = {
    ...(isRecord(run.control) ? run.control : {}),
    pauseRequestedAt: now,
    reason: options.reason,
    controlSource: 'pi-acp-offline'
  }
  updateActiveSteps(run, 'paused', now, options.reason)
  writeWorkflowRun(run)
  return run
}

export function interruptWorkflowRun(target: string, options: WorkflowRunControlOptions = {}): WorkflowRunRecord {
  const run = readWorkflowRun(target, options.workflowRunsDir)
  if (isTerminalWorkflowStatus(run.status)) throw new Error(`Cannot interrupt terminal workflow run ${run.id}.`)
  const now = new Date().toISOString()
  run.status = 'interrupted'
  run.control = {
    ...(isRecord(run.control) ? run.control : {}),
    interruptRequestedAt: now,
    reason: options.reason,
    controlSource: 'pi-acp-offline'
  }
  updateActiveSteps(run, 'interrupted', now, options.reason)
  writeWorkflowRun(run)
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
    policy: options.policy ?? 'continue-existing-session',
    continuationMessage: options.continuationMessage,
    controlSource: 'pi-acp-offline'
  }
  updateActiveSteps(run, 'recovering', now, options.reason)
  writeWorkflowRun(run)
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
  run.control = {
    ...(isRecord(run.control) ? run.control : {}),
    abortRequestedAt: now,
    reason,
    controlSource: 'pi-acp-offline'
  }
  updateActiveSteps(run, 'aborted', now, reason)
  writeWorkflowRun(run)
  return run
}

export function workflowRunHasRunEnd(runDir: string): boolean {
  return scanCompleteEventFileStats(join(runDir, 'events.jsonl')).sawRunEnd
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

function scanWorkflowEventFile(
  eventsPath: string,
  options: { offset?: number; sinceSequence?: number; limit?: number }
): {
  events: Record<string, unknown>[]
  nextOffset: number
  lastSequence?: number
  malformedLineCount: number
  startOffset: number
  reachedEnd: boolean
  maxSequence: number
  sawRunEnd: boolean
} {
  const size = readFileSize(eventsPath)
  const startOffset = Math.min(Math.max(0, options.offset ?? 0), size)
  const events: Record<string, unknown>[] = []
  const result = {
    events,
    nextOffset: startOffset,
    lastSequence: undefined as number | undefined,
    malformedLineCount: 0,
    startOffset,
    reachedEnd: startOffset >= size,
    maxSequence: 0,
    sawRunEnd: false
  }
  if (options.limit !== undefined && options.limit <= 0) return result
  if (startOffset >= size) return result

  scanJsonlLines(eventsPath, startOffset, size, (line, lineNextOffset) => {
    result.nextOffset = lineNextOffset
    const parsed = parseEventLine(line)
    if (parsed.status === 'blank') return true
    if (parsed.status === 'malformed') {
      result.malformedLineCount += 1
      return true
    }
    const record = parsed.record
    if (record.type === 'run_end') result.sawRunEnd = true
    const sequence = numberField(record.sequence)
    if (sequence !== undefined) {
      result.lastSequence = Math.max(result.lastSequence ?? 0, sequence)
      result.maxSequence = Math.max(result.maxSequence, sequence)
    }
    if (options.sinceSequence !== undefined && (sequence === undefined || sequence <= options.sinceSequence))
      return true
    events.push(record)
    return options.limit === undefined || events.length < options.limit
  })

  result.reachedEnd = result.nextOffset >= size && (options.limit === undefined || events.length < options.limit)
  if (result.reachedEnd) result.nextOffset = size
  return result
}

function scanCompleteEventFileStats(eventsPath: string): { maxSequence: number; sawRunEnd: boolean } {
  const size = readFileSize(eventsPath)
  const stats = { maxSequence: 0, sawRunEnd: false }
  if (size <= 0) return stats
  scanJsonlLines(eventsPath, 0, size, line => {
    const parsed = parseEventLine(line)
    if (parsed.status !== 'event') return true
    if (parsed.record.type === 'run_end') stats.sawRunEnd = true
    const sequence = numberField(parsed.record.sequence)
    if (sequence !== undefined && sequence > stats.maxSequence) stats.maxSequence = sequence
    return true
  })
  return stats
}

function scanJsonlLines(
  eventsPath: string,
  startOffset: number,
  size: number,
  onLine: (line: Buffer, lineNextOffset: number) => boolean
): void {
  let fd: number
  try {
    fd = openSync(eventsPath, 'r')
  } catch {
    return
  }
  try {
    const readBuffer = Buffer.allocUnsafe(Math.min(EVENT_READ_CHUNK_BYTES, Math.max(1, size - startOffset)))
    let readOffset = startOffset
    let pending = Buffer.alloc(0)
    let pendingStartOffset = startOffset

    while (readOffset < size) {
      const bytesRead = readSync(fd, readBuffer, 0, Math.min(readBuffer.byteLength, size - readOffset), readOffset)
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
        const shouldContinue = onLine(data.subarray(cursor, contentEnd), lineNextOffset)
        cursor = newlineIndex + 1
        if (!shouldContinue) return
      }

      pending = Buffer.from(data.subarray(cursor))
      pendingStartOffset = dataStartOffset + cursor
    }
  } finally {
    closeSync(fd)
  }
}

function parseEventLine(
  line: Buffer
): { status: 'blank' } | { status: 'malformed' } | { status: 'event'; record: Record<string, unknown> } {
  const trimmed = line.toString('utf8').trim()
  if (!trimmed) return { status: 'blank' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { status: 'malformed' }
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return { status: 'malformed' }
  return { status: 'event', record: parsed }
}

function readFileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}
