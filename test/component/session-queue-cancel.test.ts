import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { PI_WORKFLOWS_EVENTS_METHOD } from '../../src/acp/workflows.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

async function waitForMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

test('PiAcpSession: invokes prompt acceptance hook before turn completion', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let acceptedState: unknown = undefined
  const promptPromise = session.prompt('one', [], {
    onAccepted: state => {
      acceptedState = state
    }
  })

  await waitForMicrotasks()
  assert.deepEqual(acceptedState, {})

  let promptSettled = false
  promptPromise.then(() => {
    promptSettled = true
  })
  await waitForMicrotasks()
  assert.equal(promptSettled, false)

  proc.emit({ type: 'agent_end' })
  assert.equal(await promptPromise, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 5
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: cancel suppresses late stale presentation and waits for drain before returning', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 50
  })

  const first = session.prompt('one')
  const cancelPromise = session.cancel()
  let cancelSettled = false
  cancelPromise.then(() => {
    cancelSettled = true
  })

  assert.equal(await first, 'cancelled')

  const second = session.prompt('two')
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'late thought' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late text' } } as any)
  proc.emit({ type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'read', args: { path: 'package.json' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'late-tool',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'late tool result' }] }
  })
  ;(session as any).emitCustomNotification(PI_WORKFLOWS_EVENTS_METHOD, {
    sessionId: 's1',
    runId: 'run',
    sequence: 9,
    event: { type: 'run_interrupted', runId: 'run', sequence: 9 }
  })
  await waitForMicrotasks()
  assert.equal(cancelSettled, false)
  assert.equal(proc.prompts.length, 1)
  assert.equal(
    conn.updates.some(u => JSON.stringify(u).includes('late thought')),
    false
  )
  assert.equal(
    conn.updates.some(u => JSON.stringify(u).includes('late text')),
    false
  )
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'tool_call' && (u.update as any).toolCallId === 'late-tool'),
    false
  )
  assert.equal(
    conn.updates.some(u => JSON.stringify(u).includes('late tool result')),
    true
  )
  assert.deepEqual(
    conn.extNotifications
      .filter(notification => notification.method === PI_WORKFLOWS_EVENTS_METHOD)
      .map(notification => notification.params.sequence),
    [9]
  )

  proc.emit({ type: 'agent_end' })

  await cancelPromise
  assert.equal(proc.prompts.length, 2)

  proc.emit({ type: 'agent_end' })
  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: cancel suppresses stale replay backlog but preserves semantic workflow updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let releaseUpdates!: () => void
  conn.sessionUpdateBlocker = new Promise<void>(resolve => {
    releaseUpdates = resolve
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 5
  })

  const first = session.prompt('one')
  await waitForMicrotasks()
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'stale replay text' }
  } as any)
  ;(session as any).emitCustomNotification(PI_WORKFLOWS_EVENTS_METHOD, {
    sessionId: 's1',
    runId: 'run',
    sequence: 2,
    event: { type: 'run_interrupted', runId: 'run', sequence: 2 }
  })

  const cancelPromise = session.cancel()
  await waitForMicrotasks()
  ;(session as any).emitCustomNotification(PI_WORKFLOWS_EVENTS_METHOD, {
    sessionId: 's1',
    runId: 'run',
    sequence: 3,
    event: { type: 'run_interrupted', runId: 'run', sequence: 3 }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'post-cancel stale replay text' }
  } as any)

  releaseUpdates()
  await cancelPromise
  assert.equal(await first, 'cancelled')

  assert.equal(
    conn.updates.some(update => JSON.stringify(update).includes('stale replay text')),
    false
  )
  assert.equal(
    conn.updates.some(update => JSON.stringify(update).includes('post-cancel stale replay text')),
    false
  )
  assert.deepEqual(
    conn.extNotifications
      .filter(notification => notification.method === PI_WORKFLOWS_EVENTS_METHOD)
      .map(notification => notification.params.sequence),
    [2, 3]
  )
  const pressure = session.getOutboundPressureSnapshot()
  assert.equal(pressure.cancelPresentation.droppedReplayBacklog >= 1, true)
  assert.equal(pressure.cancelPresentation.preservedSemanticBacklog >= 1, true)
})

test('PiAcpSession: cancel diagnostics count preserved-only semantic backlog', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let releaseUpdates!: () => void
  conn.sessionUpdateBlocker = new Promise<void>(resolve => {
    releaseUpdates = resolve
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 5
  })

  const first = session.prompt('one')
  await waitForMicrotasks()
  ;(session as any).emitCustomNotification(PI_WORKFLOWS_EVENTS_METHOD, {
    sessionId: 's1',
    runId: 'run',
    sequence: 4,
    event: { type: 'run_interrupted', runId: 'run', sequence: 4 }
  })

  const cancelPromise = session.cancel()
  await waitForMicrotasks()
  releaseUpdates()
  await cancelPromise
  assert.equal(await first, 'cancelled')

  assert.deepEqual(
    conn.extNotifications
      .filter(notification => notification.method === PI_WORKFLOWS_EVENTS_METHOD)
      .map(notification => notification.params.sequence),
    [4]
  )
  const pressure = session.getOutboundPressureSnapshot()
  assert.equal(pressure.cancelPresentation.droppedReplayBacklog, 0)
  assert.equal(pressure.cancelPresentation.coalescedReplayBacklog, 0)
  assert.equal(pressure.cancelPresentation.preservedSemanticBacklog >= 1, true)
})

test('PiAcpSession: continues a recoverable workflow run through Pi RPC control', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const root = join(tmpdir(), `pi-acp-session-workflow-resume-${process.pid}-${Date.now()}`)
  const runDir = join(root, 'workflow-runs', 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ id: 'run', cwd: process.cwd(), runDir, status: 'recovering', workflowId: 'wf' }),
    'utf8'
  )
  writeFileSync(join(runDir, 'events.jsonl'), '', 'utf8')
  proc.workflowControlResult = { run: { id: 'run', cwd: process.cwd(), runDir, status: 'completed' } }
  proc.workflowControl = async (action, target, opts = {}) => {
    proc.workflowControls.push({ action, target, opts })
    appendFileSync(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_end', sequence: 1, runId: 'run', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )
    return proc.workflowControlResult
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  try {
    assert.equal(await session.continueWorkflowRun({ id: 'run', runDir }, 'continue now'), 'end_turn')
    assert.deepEqual(proc.workflowControls, [
      { action: 'resume', target: runDir, opts: { continuationMessage: 'continue now' } }
    ])
    assert.equal(
      conn.updates.some(update => JSON.stringify(update).includes('Workflow wf completed')),
      true
    )
  } finally {
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpSession: cancel interrupts workflow continuation and settles the ACP turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const root = join(tmpdir(), `pi-acp-session-workflow-cancel-${process.pid}-${Date.now()}`)
  const runDir = join(root, 'workflow-runs', 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ id: 'run', cwd: process.cwd(), runDir, status: 'recovering', workflowId: 'wf' }),
    'utf8'
  )
  writeFileSync(join(runDir, 'events.jsonl'), '', 'utf8')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  try {
    const continuation = session.continueWorkflowRun({ id: 'run', runDir }, 'continue now')
    await waitForMicrotasks()
    await session.cancel()

    assert.equal(proc.abortCount, 1)
    assert.equal(await continuation, 'cancelled')
  } finally {
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpSession: cancel resolves current prompt when abort hangs', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abortPromise = new Promise(() => {})

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelAbortTimeoutMs: 5,
    cancelDrainTimeoutMs: 5
  })

  const first = session.prompt('one')
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(await first, 'cancelled')
})

test('PiAcpSession: cancel waits until the current turn is locally settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let releaseUpdates!: () => void
  conn.sessionUpdateBlocker = new Promise<void>(resolve => {
    releaseUpdates = resolve
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 5
  })

  const first = session.prompt('one')
  const cancelPromise = session.cancel()
  let cancelSettled = false
  cancelPromise.then(() => {
    cancelSettled = true
  })

  await waitForMicrotasks()
  assert.equal(cancelSettled, false)

  releaseUpdates()
  await cancelPromise
  assert.equal(await first, 'cancelled')
})
