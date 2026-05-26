import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: cancel clears queued prompts', async () => {
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

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
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
    cancelAbortTimeoutMs: 5
  })

  const first = session.prompt('one')
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
  assert.equal(await first, 'cancelled')
})
