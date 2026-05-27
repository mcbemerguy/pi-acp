import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
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

test('PiAcpSession: cancel suppresses late events and waits for drain before returning', async () => {
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

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late text' } } as any)
  await waitForMicrotasks()
  assert.equal(cancelSettled, false)
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_end' })

  await cancelPromise
  assert.equal(proc.prompts.length, 2)
  assert.equal(
    conn.updates.some(u => JSON.stringify(u).includes('late text')),
    false
  )

  proc.emit({ type: 'agent_end' })
  assert.equal(await second, 'end_turn')
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
