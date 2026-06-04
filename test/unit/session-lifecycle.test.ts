import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { windowsProcessTreeKillCommand } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

test('PiAcpAgent: advertises close and experimental delete session capabilities', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {}, _meta: null } as any)

  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.close, {})
  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.delete, {})
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

test('PiAcpAgent: session/close is safe for unknown sessions', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await agent.closeSession({ sessionId: 'already-closed', _meta: null } as any)
})

test('PiAcpAgent: delete closes an active session, removes the store entry, and unlinks only the validated JSONL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-active-'))
  const sessionFile = writeSessionFile(root, 'delete-active', '/tmp/project')
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let closedSessionId: string | null = null
  const deletedSessionIds: string[] = []

  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) =>
      sessionId === 'delete-active' ? { cwd: '/tmp/project', getSessionFile: () => sessionFile } : undefined,
    closeSession: async (sessionId: string) => {
      closedSessionId = sessionId
    },
    close: () => {}
  }
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
    await agent.unstable_deleteSession({ sessionId: 'delete-active', _meta: null } as any)

    assert.equal(closedSessionId, 'delete-active')
    assert.deepEqual(deletedSessionIds, ['delete-active'])
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

test('PiAcpAgent: delete removes stale store entries without unlinking arbitrary paths', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const missing = join(tmpdir(), `pi-acp-missing-delete-${Date.now()}.jsonl`)
  const deletedSessionIds: string[] = []

  ;(agent as any).store = {
    get: () => ({
      sessionId: 'missing-session',
      cwd: '/tmp/project',
      sessionFile: missing,
      updatedAt: '2026-02-11T00:00:00.000Z'
    }),
    delete: (sessionId: string) => deletedSessionIds.push(sessionId),
    list: () => []
  }

  await agent.unstable_deleteSession({ sessionId: 'missing-session', _meta: null } as any)

  assert.deepEqual(deletedSessionIds, ['missing-session'])
  assert.equal(existsSync(missing), false)
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
  mkdirSync(runDir, { recursive: true })
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
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  try {
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'workflow-parent',
        cwd: '/tmp/project',
        sessionFile: join(root, 'missing.jsonl'),
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      delete: () => {},
      list: () => []
    }

    await agent.unstable_deleteSession({ sessionId: 'workflow-parent', _meta: null } as any)

    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    assert.equal(run.status, 'aborted')
    assert.equal(run.error, 'Parent ACP session was deleted.')
    assert.equal(run.steps[0].status, 'aborted')
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
