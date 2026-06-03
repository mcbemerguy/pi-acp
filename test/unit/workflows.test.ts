import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  abortWorkflowRun,
  interruptWorkflowRun,
  pauseWorkflowRun,
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
