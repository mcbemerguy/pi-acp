import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  abortWorkflowRun,
  interruptWorkflowRun,
  pauseWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
  resumeWorkflowRun
} from '../../src/acp/workflows.js'

function writeRunJson(runDir: string, run: Record<string, unknown>): void {
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ id: 'run', cwd: '/repo', runDir, status: 'running', ...run }),
    'utf8'
  )
}

test('readWorkflowRunEvents does not consume an unterminated final JSONL record', () => {
  const root = join(tmpdir(), `pi-acp-workflows-partial-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'run')
  mkdirSync(runDir, { recursive: true })
  writeRunJson(runDir, { workflowId: 'wf' })
  const firstLine = `${JSON.stringify({ type: 'run_start', sequence: 1, runId: 'run', workflowId: 'wf' })}\n`
  writeFileSync(join(runDir, 'events.jsonl'), `${firstLine}{"type":"step_start","sequence":2`, 'utf8')

  try {
    const first = readWorkflowRunEvents('run', { workflowRunsDir })
    assert.equal(first.events.length, 1)
    assert.equal(first.nextOffset, Buffer.byteLength(firstLine))
    assert.equal(first.malformedLineCount, 0)
    assert.equal(first.lastSequence, 1)

    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${firstLine}{"type":"step_start","sequence":2,"runId":"run","workflowId":"wf","stepId":"code"}\n`,
      'utf8'
    )
    const second = readWorkflowRunEvents('run', { workflowRunsDir, offset: first.nextOffset })
    assert.deepEqual(
      second.events.map(event => event.type),
      ['step_start']
    )
    assert.equal(second.events[0]?.sequence, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readWorkflowRunEvents stops parsing a large file after a limited page is satisfied', () => {
  const root = join(tmpdir(), `pi-acp-workflows-large-page-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'run')
  const eventsPath = join(runDir, 'events.jsonl')
  mkdirSync(runDir, { recursive: true })
  writeRunJson(runDir, { workflowId: 'wf' })
  const fd = openSync(eventsPath, 'w')
  let expectedNextOffset = 0
  try {
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      expectedNextOffset += writeSync(
        fd,
        `${JSON.stringify({ type: 'step_update', sequence, runId: 'run', workflowId: 'wf', stepId: `step-${sequence}` })}\n`
      )
    }
    writeSync(fd, '{ malformed json after requested page\n')
    const payload = 'x'.repeat(512)
    for (let sequence = 6; sequence <= 12_000; sequence += 1) {
      writeSync(
        fd,
        `${JSON.stringify({ type: 'child_pi_event', sequence, runId: 'run', workflowId: 'wf', stepId: 'bulk', payload })}\n`
      )
    }
  } finally {
    closeSync(fd)
  }

  const originalParse = JSON.parse
  let parseCalls = 0
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    parseCalls += 1
    return originalParse(text, reviver)
  }) as typeof JSON.parse
  try {
    const replay = readWorkflowRunEvents('run', { workflowRunsDir, limit: 5 })
    assert.deepEqual(
      replay.events.map(event => event.sequence),
      [1, 2, 3, 4, 5]
    )
    assert.equal(replay.nextOffset, expectedNextOffset)
    assert.equal(replay.malformedLineCount, 0)
    assert.equal(replay.lastSequence, 5)
    assert.equal(parseCalls, 6)
    assert.ok(replay.nextOffset < statSync(eventsPath).size)
  } finally {
    JSON.parse = originalParse
    rmSync(root, { recursive: true, force: true })
  }
})

test('readWorkflowRun includes the latest workflow event sequence', () => {
  const root = join(tmpdir(), `pi-acp-workflows-run-sequence-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'run')
  mkdirSync(runDir, { recursive: true })
  writeRunJson(runDir, { workflowId: 'wf' })
  writeFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_start', sequence: 1, runId: 'run', workflowId: 'wf' })}\n` +
      `${JSON.stringify({ type: 'run_interrupted', sequence: 8, runId: 'run', workflowId: 'wf', status: 'interrupted' })}\n`,
    'utf8'
  )

  try {
    assert.equal(readWorkflowRun('run', workflowRunsDir).lastSequence, 8)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline workflow controls update run.json without appending events.jsonl records', () => {
  const root = join(tmpdir(), `pi-acp-workflows-control-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'run')
  const eventsPath = join(runDir, 'events.jsonl')
  mkdirSync(runDir, { recursive: true })
  writeRunJson(runDir, {
    workflowId: 'wf',
    steps: [{ id: 'code', status: 'running' }]
  })
  const initialEvents = `${JSON.stringify({ type: 'run_start', sequence: 1, runId: 'run', workflowId: 'wf' })}\n`
  writeFileSync(eventsPath, initialEvents, 'utf8')

  try {
    assert.equal(pauseWorkflowRun('run', { workflowRunsDir, reason: 'manual pause' }).status, 'paused')
    assert.equal(resumeWorkflowRun('run', { workflowRunsDir, policy: 'redo-step' }).status, 'recovering')
    assert.equal(interruptWorkflowRun('run', { workflowRunsDir, reason: 'stop' }).status, 'interrupted')
    assert.equal(abortWorkflowRun('run', { workflowRunsDir, reason: 'explicit abort' }).status, 'aborted')

    assert.equal(readFileSync(eventsPath, 'utf8'), initialEvents)
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    assert.equal(run.control.controlSource, 'pi-acp-offline')
    assert.equal(run.status, 'aborted')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readWorkflowRunEvents computes terminal fallback sequence from the full event file', () => {
  const root = join(tmpdir(), `pi-acp-workflows-fallback-sequence-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'run')
  mkdirSync(runDir, { recursive: true })
  writeRunJson(runDir, { workflowId: 'wf', status: 'completed', endedAt: '2026-05-30T00:00:00.000Z' })
  const content =
    `${JSON.stringify({ type: 'run_start', sequence: 1, runId: 'run', workflowId: 'wf' })}\n` +
    `${JSON.stringify({ type: 'step_end', sequence: 7, runId: 'run', workflowId: 'wf', stepId: 'code' })}\n`
  writeFileSync(join(runDir, 'events.jsonl'), content, 'utf8')

  try {
    const replay = readWorkflowRunEvents('run', {
      workflowRunsDir,
      offset: Buffer.byteLength(content),
      sinceSequence: 7,
      includeTerminalFallback: true
    })

    assert.equal(replay.events.length, 1)
    assert.equal(replay.terminalFallback?.sequence, 8)
    assert.equal(replay.events[0]?.type, 'run_end')
    assert.equal(replay.events[0]?.sequence, 8)
    assert.equal(replay.lastSequence, 8)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
