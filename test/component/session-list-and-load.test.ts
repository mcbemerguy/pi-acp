import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { validatePiSessionFile } from '../../src/acp/pi-sessions.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

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

test('PiAcpAgent: repeated loadSession of the same active session reuses the live pi process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-active-load-'))
  const sessionFile = join(root, 'active.jsonl')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'active-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )

  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  let closeCalls = 0
  let closeAllExceptCalls = 0
  let getMessagesCalls = 0
  let getCommandsCalls = 0
  let updatedSessionFile: string | null = null
  const upserts: Array<{ sessionId: string; cwd: string; sessionFile: string }> = []

  const proc = {
    getState: async () => ({
      sessionId: 'active-session',
      cwd: '/tmp/project',
      sessionFile,
      thinkingLevel: 'high',
      model: { provider: 'test', id: 'fast' }
    }),
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'fast', name: 'Fast' }] }),
    getMessages: async () => {
      getMessagesCalls += 1
      return { messages: [{ role: 'user', content: 'should not replay active history' }] }
    },
    getCommands: async () => {
      getCommandsCalls += 1
      throw new Error('use file command fallback')
    },
    dispose: () => {
      throw new Error('active process should not be disposed')
    }
  }

  const activeSession = {
    sessionId: 'active-session',
    cwd: '/tmp/project',
    proc,
    getSessionFile: () => sessionFile,
    updateSessionFile: (value: string | null) => {
      updatedSessionFile = value
    },
    updateFileCommands: () => {},
    attachWorkflowRun: async () => {
      throw new Error('no workflow runs should be attached in this test')
    }
  }

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawnCalls += 1
      throw new Error('spawn should not be called for active idempotent load')
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => null,
      list: () => [],
      delete: () => {},
      upsert: (entry: { sessionId: string; cwd: string; sessionFile: string }) => upserts.push(entry)
    }
    ;(agent as any).sessions = {
      maybeGet: (sessionId: string) => (sessionId === 'active-session' ? activeSession : undefined),
      close: () => {
        closeCalls += 1
      },
      getOrCreate: () => {
        throw new Error('getOrCreate should not be called for active idempotent load')
      },
      closeAllExcept: () => {
        closeAllExceptCalls += 1
      }
    }

    const response = await agent.loadSession({
      sessionId: 'active-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    assert.equal(spawnCalls, 0)
    assert.equal(closeCalls, 0)
    assert.equal(closeAllExceptCalls, 0)
    assert.equal(getMessagesCalls, 0)
    assert.equal(updatedSessionFile, sessionFile)
    assert.deepEqual(upserts, [{ sessionId: 'active-session', cwd: '/tmp/project', sessionFile }])
    assert.equal(response.configOptions?.find(option => option.id === 'model')?.currentValue, 'test/fast')
    assert.equal(response.configOptions?.find(option => option.id === 'thinking_level')?.currentValue, 'high')

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(getCommandsCalls, 1)
    assert.ok(
      conn.updates.some(update => (update.update as any).sessionUpdate === 'available_commands_update'),
      'loadSession should re-advertise commands for active sessions'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: repeated active load refreshes file slash commands used by prompt expansion', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-active-command-refresh-'))
  const promptsDir = join(cwd, '.pi', 'prompts')
  const sessionFile = join(cwd, 'active.jsonl')
  const commandName = 'refresh_active_load_command'
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, `${commandName}.md`), 'Refreshed $1', 'utf8')
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'active-command-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd
    }) + '\n',
    'utf8'
  )

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'active-command-session',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: commandName,
        description: 'stale',
        content: 'Stale $1',
        source: '(test)'
      }
    ],
    sessionFile,
    projectTrustPolicy: 'trusted'
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).store = {
    get: () => null,
    list: () => [],
    delete: () => {},
    upsert: () => {}
  }
  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => (sessionId === 'active-command-session' ? session : undefined),
    close: () => {
      throw new Error('active session should not be closed')
    }
  }

  await agent.loadSession({
    sessionId: 'active-command-session',
    cwd,
    mcpServers: [],
    _meta: { piAcp: { projectTrust: 'trusted' } }
  } as any)

  const prompt = session.prompt(`/${commandName} topic`)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.prompts[0]?.message, 'Refreshed topic')
})

test('PiAcpAgent: repeated active load falls back to close and spawn when cwd mismatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-active-cwd-mismatch-'))
  const sessionFile = join(root, 'target.jsonl')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'same-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )

  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  let closeCalls = 0

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawnCalls += 1
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getState: async () => ({ sessionId: 'same-session', sessionFile, thinkingLevel: 'medium' }),
        getAvailableModels: async () => ({ models: [] }),
        getCommands: async () => ({ commands: [] })
      } as any
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'same-session',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: () => {},
      upsert: () => {}
    }
    ;(agent as any).sessions = {
      maybeGet: () => ({
        sessionId: 'same-session',
        cwd: '/tmp/other-project',
        proc: { getState: async () => ({ sessionId: 'same-session', cwd: '/tmp/other-project' }) },
        getSessionFile: () => null,
        updateSessionFile: () => {}
      }),
      close: (sessionId: string) => {
        assert.equal(sessionId, 'same-session')
        closeCalls += 1
      },
      getOrCreate: (_sessionId: string, params: any) => ({
        sessionId: 'same-session',
        cwd: '/tmp/project',
        proc: params.proc,
        getSessionFile: () => sessionFile,
        updateSessionFile: () => {},
        attachWorkflowRun: async () => {}
      }),
      closeAllExcept: () => {}
    }

    await agent.loadSession({ sessionId: 'same-session', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    assert.equal(closeCalls, 1)
    assert.equal(spawnCalls, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loading a different session spawns and enforces one live pi process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-load-different-'))
  const sessionFile = join(root, 'target.jsonl')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'target-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )

  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  const closeAllExceptArgs: string[] = []

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawnCalls += 1
      return {
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getState: async () => ({ sessionId: 'target-session', sessionFile, thinkingLevel: 'medium' }),
        getAvailableModels: async () => ({ models: [] }),
        getCommands: async () => ({ commands: [] })
      } as any
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'target-session',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:00.000Z'
      }),
      list: () => [],
      delete: () => {},
      upsert: () => {}
    }
    ;(agent as any).sessions = {
      maybeGet: () => undefined,
      close: () => {
        throw new Error('target session should not be closed before spawn when it is not active')
      },
      getOrCreate: (_sessionId: string, params: any) => ({
        sessionId: 'target-session',
        cwd: '/tmp/project',
        proc: params.proc,
        getSessionFile: () => sessionFile,
        updateSessionFile: () => {},
        attachWorkflowRun: async () => {}
      }),
      closeAllExcept: (sessionId: string) => closeAllExceptArgs.push(sessionId)
    }

    await agent.loadSession({ sessionId: 'target-session', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    assert.equal(spawnCalls, 1)
    assert.deepEqual(closeAllExceptArgs, ['target-session'])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays and reattaches recoverable workflow runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-load-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_workflow-session.jsonl')
  const runDir = join(root, 'workflow-runs', 'wf-run')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'workflow-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'wf-run',
      workflowId: 'review',
      cwd: '/tmp/project',
      parentSessionId: 'workflow-session',
      runDir,
      status: 'running',
      startedAt: '2026-02-11T00:00:01.000Z'
    }),
    'utf8'
  )
  writeFileSync(
    join(runDir, 'events.jsonl'),
    [
      {
        type: 'run_start',
        sequence: 1,
        timestamp: 't1',
        runId: 'wf-run',
        workflowId: 'review',
        cwd: '/tmp/project',
        status: 'running'
      },
      {
        type: 'step_start',
        sequence: 2,
        timestamp: 't2',
        runId: 'wf-run',
        workflowId: 'review',
        stepId: 'code',
        stepType: 'agent',
        status: 'running'
      }
    ]
      .map(record => JSON.stringify(record))
      .join('\n') + '\n',
    'utf8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn
  let spawnCalls = 0
  let getMessagesCalls = 0

  try {
    ;(PiRpcProcess as any).spawn = async () => {
      spawnCalls += 1
      return {
        onEvent: () => () => {},
        getMessages: async () => {
          getMessagesCalls += 1
          return { messages: [] }
        },
        getState: async () => ({ sessionId: 'workflow-session', cwd: '/tmp/project', sessionFile }),
        getAvailableModels: async () => ({ models: [] }),
        getCommands: async () => ({ commands: [] })
      } as any
    }

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.loadSession({ sessionId: 'workflow-session', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

    const updates = conn.updates.map(item => item.update as any)
    assert.deepEqual(
      updates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
      ['workflow:wf-run']
    )
    assert.equal(updates.filter(update => update.sessionUpdate === 'plan').length, 1)
    assert.ok(
      conn.extNotifications.some(item => item.method === '_pi/workflows/events' && item.params.runId === 'wf-run')
    )

    await agent.loadSession({ sessionId: 'workflow-session', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)
    const updatesAfterRepeatedLoad = conn.updates.map(item => item.update as any)
    assert.equal(spawnCalls, 1)
    assert.equal(getMessagesCalls, 1)
    assert.deepEqual(
      updatesAfterRepeatedLoad.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
      ['workflow:wf-run']
    )
    assert.equal(updatesAfterRepeatedLoad.filter(update => update.sessionUpdate === 'plan').length, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: loadSession replays terminal workflow fallback without duplicate run_end updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-load-terminal-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_workflow-terminal-session.jsonl')
  const runDir = join(root, 'workflow-runs', 'wf-terminal')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'workflow-terminal-session',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project'
    }) + '\n',
    'utf8'
  )
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'wf-terminal',
      workflowId: 'review',
      cwd: '/tmp/project',
      parentSessionId: 'workflow-terminal-session',
      runDir,
      status: 'completed',
      endedAt: '2026-02-11T00:00:02.000Z',
      startedAt: '2026-02-11T00:00:01.000Z'
    }),
    'utf8'
  )
  writeFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_start', sequence: 1, timestamp: 't1', runId: 'wf-terminal', workflowId: 'review', cwd: '/tmp/project', status: 'running' })}\n`,
    'utf8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const originalSpawn = PiRpcProcess.spawn

  try {
    ;(PiRpcProcess as any).spawn = async () =>
      ({
        onEvent: () => () => {},
        getMessages: async () => ({ messages: [] }),
        getState: async () => ({ sessionId: 'workflow-terminal-session', sessionFile }),
        getAvailableModels: async () => ({ models: [] })
      }) as any

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.loadSession({
      sessionId: 'workflow-terminal-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: null
    } as any)

    const finalUpdates = conn.updates
      .map(item => item.update as any)
      .filter(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:wf-terminal')
    assert.equal(finalUpdates.length, 1)
    assert.equal(finalUpdates[0].status, 'completed')
    assert.equal(finalUpdates[0].rawOutput.status, 'completed')
  } finally {
    PiRpcProcess.spawn = originalSpawn
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

test('validatePiSessionFile: rejects headers pi cannot load safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-header-validation-'))
  const writeHeader = (name: string, header: Record<string, unknown>) => {
    const file = join(root, `${name}.jsonl`)
    writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8' })
    return file
  }

  const baseHeader = {
    type: 'session',
    version: 3,
    id: 'session-1',
    timestamp: '2026-02-11T00:00:00.000Z',
    cwd: '/tmp/project'
  }

  assert.equal(validatePiSessionFile(writeHeader('valid-v3', baseHeader)).ok, true)
  assert.equal(validatePiSessionFile(writeHeader('valid-legacy-v1', { ...baseHeader, version: undefined })).ok, true)
  assert.deepEqual(validatePiSessionFile(writeHeader('future-version', { ...baseHeader, version: 999 })), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(validatePiSessionFile(writeHeader('missing-timestamp', { ...baseHeader, timestamp: undefined })), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(
    validatePiSessionFile(writeHeader('invalid-timestamp', { ...baseHeader, timestamp: 'not-a-date' })),
    {
      ok: false,
      reason: 'invalid'
    }
  )
  assert.deepEqual(validatePiSessionFile(writeHeader('invalid-parent', { ...baseHeader, parentSession: 42 })), {
    ok: false,
    reason: 'invalid'
  })
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

test('PiAcpAgent: cancelled prompt does not wait for post-turn usage refresh', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  let statsRequested = false
  let stateRequested = false

  ;(agent as any).sessions = {
    get: () => ({
      sessionId: 'prompt-session',
      cwd: '/tmp/project',
      prompt: async () => 'cancelled',
      wasCancelRequested: () => true,
      updateSessionFile: () => {},
      publishUsageUpdateFromStats: () => {},
      publishPiUsageTelemetryFromStats: () => {},
      proc: {
        getSessionStats: async () => {
          statsRequested = true
          await new Promise(() => {})
        },
        getState: async () => {
          stateRequested = true
          await new Promise(() => {})
        }
      }
    })
  }

  const response = await Promise.race([
    agent.prompt({ sessionId: 'prompt-session', prompt: [{ type: 'text', text: 'hi' }] } as any),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('prompt timed out')), 50))
  ])

  assert.equal(response.stopReason, 'cancelled')
  assert.equal(statsRequested, false)
  assert.equal(stateRequested, false)
})

test('PiAcpAgent: prompt refreshes ACP session map as soon as prompt is accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-accepted-map-'))
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
      prompt: async (_message: string, _images: unknown[], lifecycle?: { onAccepted?: (state: unknown) => void }) => {
        lifecycle?.onAccepted?.({ sessionId: 'prompt-session', sessionFile })
        assert.deepEqual(upserts, [{ sessionId: 'prompt-session', cwd: '/tmp/project', sessionFile }])
        assert.equal(updatedSessionFile, sessionFile)
        return 'end_turn'
      },
      wasCancelRequested: () => false,
      updateSessionFile: (value: string | null) => {
        updatedSessionFile = value
      },
      proc: {
        getSessionStats: async () => undefined,
        getState: async () => ({ sessionId: 'prompt-session' })
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
