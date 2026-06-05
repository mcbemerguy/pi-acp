import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { windowsProcessTreeKillCommand } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

test('PiAcpAgent: advertises close and private Pi delete session capabilities', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {}, _meta: null } as any)

  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.close, {})
  assert.equal((response.agentCapabilities?.sessionCapabilities as any)?.delete, undefined)
  assert.deepEqual((response.agentCapabilities?._meta as any)?.piAcp?.sessionDelete, true)
  assert.deepEqual((response.agentCapabilities?._meta as any)?.piAcp?.sessionDeleteMethod, '_pi/session/delete')
})

test('PiAcpSession: close cancels active work and disposes the subprocess', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'active-session',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    cancelDrainTimeoutMs: 5
  })

  const prompt = session.prompt('work')
  await wait()

  await session.close()
  const reason = await prompt

  assert.equal(reason, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.disposeCount, 1)
})

test('PiAcpSession: close terminates even when outbound session updates are blocked', async () => {
  const conn = new FakeAgentSideConnection()
  conn.sessionUpdateBlocker = new Promise(() => {})
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'blocked-close',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    cancelDrainTimeoutMs: 5
  })

  const prompt = session.prompt('work')
  await wait()

  const result = await Promise.race([session.close().then(() => 'closed'), wait(200).then(() => 'timeout')])

  assert.equal(result, 'closed')
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.disposeCount, 1)
})

test('PiAcpSession: close tolerates an already-dead Pi RPC process during cancellation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.abortError = new Error('Pi RPC process exited before abort could be sent')
  const session = new PiAcpSession({
    sessionId: 'dead-process-close',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    cancelDrainTimeoutMs: 5
  })

  const prompt = session.prompt('work')
  await wait()

  const result = await Promise.race([session.close().then(() => 'closed'), wait(200).then(() => 'timeout')])

  assert.equal(result, 'closed')
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.abortCount, 1)
  assert.equal(proc.terminateCount, 1)
  assert.equal(proc.disposeCount, 2)
})

test('PiAcpAgent: session/close is safe for unknown sessions', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await agent.closeSession({ sessionId: 'already-closed', _meta: null } as any)
})

test('PiAcpAgent: private delete closes an active session process, removes the store entry, and unlinks only the validated JSONL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-active-'))
  const sessionFile = writeSessionFile(root, 'delete-active', '/tmp/project')
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const deletedSessionIds: string[] = []

  ;(agent as any).sessions.getOrCreate('delete-active', {
    cwd: '/tmp/project',
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as any,
    fileCommands: [],
    sessionFile
  })
  ;(agent as any).store = {
    get: () => ({
      sessionId: 'delete-active',
      cwd: '/tmp/project',
      sessionFile,
      updatedAt: '2026-02-11T00:00:00.000Z'
    }),
    delete: (sessionId: string) => deletedSessionIds.push(sessionId),
    list: () => []
  }

  try {
    const response = await agent.extMethod('_pi/session/delete', { sessionId: 'delete-active' })

    assert.equal(proc.terminateCount, 1)
    assert.equal(proc.disposeCount, 1)
    assert.deepEqual(deletedSessionIds, ['delete-active'])
    assert.equal(existsSync(sessionFile), false)
    assert.equal((response._meta as any).piAcp.deleteCleanup.sessionFile.status, 'deleted')
    assert.equal((agent as any).sessions.maybeGet('delete-active'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: private delete extension removes a validated mapped session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-private-delete-'))
  const sessionFile = writeSessionFile(root, 'private-delete', '/tmp/project')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const deletedSessionIds: string[] = []

  ;(agent as any).store = {
    get: () => ({
      sessionId: 'private-delete',
      cwd: '/tmp/project',
      sessionFile,
      updatedAt: '2026-02-11T00:00:00.000Z'
    }),
    delete: (sessionId: string) => deletedSessionIds.push(sessionId),
    list: () => []
  }

  try {
    await agent.extMethod('_pi/session/delete', { sessionId: 'private-delete' })

    assert.deepEqual(deletedSessionIds, ['private-delete'])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: delete unlinks an inactive listed session discovered from pi sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-inactive-'))
  const sessionFile = writeSessionFile(join(root, 'sessions', '--tmp--project--'), 'delete-inactive', '/tmp/project')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).lastSessionCwd = '/tmp/project'

  try {
    await agent.unstable_deleteSession({ sessionId: 'delete-inactive', _meta: null } as any)

    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: private delete with no active process and missing JSONL is bounded and removes the stale store entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-missing-delete-'))
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const missing = join(root, 'missing-session.jsonl')
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'missing-session', cwd: '/tmp/project', sessionFile: missing })
  ;(agent as any).store = store

  try {
    const result = await Promise.race([
      agent.extMethod('_pi/session/delete', { sessionId: 'missing-session' }),
      wait(200).then(() => 'timeout')
    ])

    assert.notEqual(result, 'timeout')
    assert.equal(store.getIncludingMissing('missing-session'), null)
    assert.equal(existsSync(missing), false)
    assert.equal(((result as any)._meta as any).piAcp.deleteCleanup.sessionFile.status, 'missing')
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: delete preserves store mapping and reports failure when unlink fails', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const deletedSessionIds: string[] = []

  ;(agent as any).store = {
    get: () => ({
      sessionId: 'unlink-fails',
      cwd: '/tmp/project',
      sessionFile: '/tmp/project/unlink-fails.jsonl',
      updatedAt: '2026-02-11T00:00:00.000Z'
    }),
    delete: (sessionId: string) => deletedSessionIds.push(sessionId),
    list: () => []
  }
  ;(agent as any).deleteValidatedPiSessionFile = () => {
    throw new Error('EACCES: permission denied')
  }

  await assert.rejects(
    agent.unstable_deleteSession({ sessionId: 'unlink-fails', _meta: null } as any),
    /Failed to delete session file for unlink-fails: EACCES/
  )
  assert.deepEqual(deletedSessionIds, [])
})

test('PiAcpAgent: delete refuses wrong-session and wrong-cwd mapped files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-wrong-'))
  const wrongSessionFile = writeSessionFile(join(root, 'wrong-session'), 'other-session', '/tmp/project')
  const wrongCwdFile = writeSessionFile(join(root, 'wrong-cwd'), 'target-session', '/tmp/other')

  try {
    await assertDoesNotDeleteMappedFile('target-session', '/tmp/project', wrongSessionFile)
    await assertDoesNotDeleteMappedFile('target-session', '/tmp/project', wrongCwdFile)

    assert.equal(existsSync(wrongSessionFile), true)
    assert.equal(existsSync(wrongCwdFile), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiAcpAgent: delete marks recoverable workflow runs aborted instead of auto-resumable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-workflow-'))
  const runDir = join(root, 'workflow-runs', 'wf-run')
  const terminalRunDir = join(root, 'workflow-runs', 'wf-terminal')
  mkdirSync(runDir, { recursive: true })
  mkdirSync(terminalRunDir, { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'wf-run',
      workflowId: 'review',
      cwd: '/tmp/project',
      parentSessionId: 'workflow-parent',
      runDir,
      status: 'running',
      steps: [{ id: 'code', status: 'running' }]
    }),
    'utf8'
  )
  writeFileSync(join(runDir, 'events.jsonl'), '{"type":"run_start","runId":"wf-run"}\n', 'utf8')
  writeFileSync(
    join(terminalRunDir, 'run.json'),
    JSON.stringify({
      id: 'wf-terminal',
      workflowId: 'review',
      cwd: '/tmp/project',
      parentSessionId: 'workflow-parent',
      runDir: terminalRunDir,
      status: 'failed',
      steps: [{ id: 'code', status: 'failed' }]
    }),
    'utf8'
  )
  writeFileSync(join(terminalRunDir, 'events.jsonl'), '{"type":"run_start","runId":"wf-terminal"}\n', 'utf8')
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'workflow-parent', cwd: '/tmp/project', sessionFile: join(root, 'missing.jsonl') })
  ;(agent as any).store = store

  try {
    const response = await agent.unstable_deleteSession({ sessionId: 'workflow-parent', _meta: null } as any)

    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    const terminalRun = JSON.parse(readFileSync(join(terminalRunDir, 'run.json'), 'utf8'))
    assert.equal(run.status, 'aborted')
    assert.equal(run.error, 'Parent ACP session was deleted.')
    assert.equal(run.steps[0].status, 'aborted')
    assert.equal(terminalRun.status, 'failed')
    assert.equal(existsSync(runDir), true)
    assert.equal(existsSync(join(runDir, 'events.jsonl')), true)
    assert.equal(existsSync(terminalRunDir), true)
    assert.equal(existsSync(join(terminalRunDir, 'events.jsonl')), true)
    assert.deepEqual((response._meta as any).piAcp.deleteCleanup.workflows.abortedRunIds, ['wf-run'])
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
    rmSync(root, { recursive: true, force: true })
  }
})

test('PiRpcProcess: Windows process-tree kill uses taskkill /T /F for shell launchers', () => {
  assert.deepEqual(windowsProcessTreeKillCommand(1234), {
    command: 'taskkill',
    args: ['/PID', '1234', '/T', '/F'],
    options: { stdio: 'ignore', windowsHide: true }
  })
})

async function assertDoesNotDeleteMappedFile(sessionId: string, cwd: string, sessionFile: string): Promise<void> {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get: () => ({ sessionId, cwd, sessionFile, updatedAt: '2026-02-11T00:00:00.000Z' }),
    delete: () => {},
    list: () => []
  }

  await agent.unstable_deleteSession({ sessionId, _meta: null } as any)
}

function writeSessionFile(dir: string, sessionId: string, cwd: string): string {
  mkdirSync(dir, { recursive: true })
  const sessionFile = join(dir, `${sessionId}.jsonl`)
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd
    }) + '\n',
    'utf8'
  )
  return sessionFile
}
