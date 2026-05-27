import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('PiAcpAgent: loadSession rejects stale absolute ACP mapping that points at another session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-stale-map-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, 'wrong-session.jsonl')
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'other-session',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  let spawned = false

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawned = true
      throw new Error('spawn should not be called')
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const deletedSessionIds: string[] = []
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'wanted-session',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: (sessionId: string) => deletedSessionIds.push(sessionId)
    }

    await assert.rejects(
      () =>
        agent.loadSession({
          sessionId: 'wanted-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: null
        } as any),
      (err: any) => err?.data === 'Unknown sessionId: wanted-session'
    )
    assert.equal(spawned, false)
    assert.deepEqual(deletedSessionIds, ['wanted-session'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: listSessions lists pi sessions and loadSession replays history', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
    const originalSpawn = PiRpcProcess.spawn

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.replace(/\\/g, '/').endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
          ]
        }),
        getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'Model' }] }),
        getState: async () => ({ thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } })
      } as any
    }

    try {
      const response = await agent.loadSession({
        sessionId: 'sess-1',
        cwd: '/tmp/project',
        mcpServers: [],
        _meta: null
      } as any)

      assert.ok(Array.isArray(response.configOptions))
      assert.equal((response as any).models, undefined)
      assert.equal((response as any).modes, undefined)
      assert.equal(response.configOptions?.find(option => option.id === 'model')?.category, 'model')
      assert.equal(response.configOptions?.find(option => option.id === 'thinking_level')?.category, 'thought_level')

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: loadSession rejects and deletes missing ACP mapping before spawn', async () => {
  const originalSpawn = PiRpcProcess.spawn
  let spawned = false

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawned = true
      throw new Error('spawn should not be called')
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const deletedSessionIds: string[] = []
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'missing-session',
        cwd: '/tmp/project',
        sessionFile: join(tmpdir(), `pi-acp-missing-${Date.now()}.jsonl`),
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: (sessionId: string) => deletedSessionIds.push(sessionId)
    }

    await assert.rejects(
      () =>
        agent.loadSession({
          sessionId: 'missing-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: null
        } as any),
      (err: any) => err?.data === 'Unknown sessionId: missing-session'
    )
    assert.equal(spawned, false)
    assert.deepEqual(deletedSessionIds, ['missing-session'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession rejects and deletes empty ACP mapping before spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-empty-map-'))
  const sessionFile = join(root, 'empty.jsonl')
  writeFileSync(sessionFile, '', { encoding: 'utf8' })

  const originalSpawn = PiRpcProcess.spawn
  let spawned = false

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawned = true
      throw new Error('spawn should not be called')
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const deletedSessionIds: string[] = []
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'empty-session',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: (sessionId: string) => deletedSessionIds.push(sessionId)
    }

    await assert.rejects(
      () =>
        agent.loadSession({
          sessionId: 'empty-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: null
        } as any),
      (err: any) => err?.data === 'Unknown sessionId: empty-session'
    )
    assert.equal(spawned, false)
    assert.deepEqual(deletedSessionIds, ['empty-session'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: prompt refreshes ACP session map from pi state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-map-'))
  const sessionFile = join(root, 'session.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'prompt-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    { encoding: 'utf8' }
  )

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const upserts: Array<{ sessionId: string; cwd: string; sessionFile: string }> = []
  let updatedSessionFile: string | null = null

  ;(agent as any).store = {
    get: () => null,
    list: () => [],
    delete: () => {},
    upsert: (entry: { sessionId: string; cwd: string; sessionFile: string }) => upserts.push(entry)
  }
  ;(agent as any).sessions = {
    get: () => ({
      sessionId: 'prompt-session',
      cwd: '/tmp/project',
      prompt: async () => 'end_turn',
      wasCancelRequested: () => false,
      updateSessionFile: (value: string | null) => {
        updatedSessionFile = value
      },
      proc: {
        getSessionStats: async () => undefined,
        getState: async () => ({ sessionId: 'prompt-session', sessionFile })
      }
    })
  }

  const response = await agent.prompt({ sessionId: 'prompt-session', prompt: [{ type: 'text', text: 'hi' }] } as any)

  assert.equal(response.stopReason, 'end_turn')
  assert.deepEqual(upserts, [{ sessionId: 'prompt-session', cwd: '/tmp/project', sessionFile }])
  assert.equal(updatedSessionFile, sessionFile)
})

test('PiAcpAgent: loadSession rejects and deletes invalid ACP mapping before spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-invalid-map-'))
  const sessionFile = join(root, 'invalid.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'not a header' } }) + '\n',
    {
      encoding: 'utf8'
    }
  )

  const originalSpawn = PiRpcProcess.spawn
  let spawned = false

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawned = true
      throw new Error('spawn should not be called')
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const deletedSessionIds: string[] = []
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'invalid-session',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: (sessionId: string) => deletedSessionIds.push(sessionId)
    }

    await assert.rejects(
      () =>
        agent.loadSession({
          sessionId: 'invalid-session',
          cwd: '/tmp/project',
          mcpServers: [],
          _meta: null
        } as any),
      (err: any) => err?.data === 'Unknown sessionId: invalid-session'
    )
    assert.equal(spawned, false)
    assert.deepEqual(deletedSessionIds, ['invalid-session'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
