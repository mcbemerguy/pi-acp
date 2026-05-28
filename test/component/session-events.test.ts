import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: refreshes usage after tool result message end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { input: 100, output: 25, cacheRead: 5, cacheWrite: 0, total: 130 },
    contextUsage: { tokens: 240, contextWindow: 1000 },
    cost: 0.12
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_end', message: { role: 'toolResult' } })

  await wait(350)

  assert.equal(proc.getSessionStatsCount, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'usage_update',
    used: 240,
    size: 1000,
    cost: { amount: 0.12, currency: 'USD' }
  })
  assert.deepEqual(conn.extNotifications, [
    {
      method: '_pi/session_usage_update',
      params: {
        sessionId: 's1',
        usage: {
          context: { usedTokens: 240, maxTokens: 1000 },
          totals: { totalTokens: 130, inputTokens: 100, outputTokens: 25, cachedReadTokens: 5, cachedWriteTokens: 0 },
          cost: { amount: 0.12, currency: 'USD' }
        }
      }
    }
  ])
})

test('PiAcpSession: coalesces rapid usage refresh boundaries', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } })
  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  proc.emit({ type: 'message_end', message: { role: 'toolResult' } })

  await wait(350)

  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(conn.updates.filter(entry => entry.update.sessionUpdate === 'usage_update').length, 1)
  assert.equal(conn.extNotifications.filter(entry => entry.method === '_pi/session_usage_update').length, 1)
})

test('PiAcpSession: drops stale live usage refresh results after a forced refresh starts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const staleStats = {
    tokens: { input: 10, output: 5, total: 15 },
    contextUsage: { tokens: 15, contextWindow: 1000 },
    cost: 0.01
  }
  const finalStats = {
    tokens: { input: 100, output: 50, total: 150 },
    contextUsage: { tokens: 150, contextWindow: 1000 },
    cost: 0.1
  }
  let statsCalls = 0
  let releaseStaleRefresh!: () => void
  const staleRefreshStarted = new Promise<void>(resolve => {
    proc.getSessionStats = async () => {
      statsCalls += 1
      if (statsCalls === 1) {
        resolve()
        await new Promise<void>(release => {
          releaseStaleRefresh = release
        })
        return staleStats
      }
      return finalStats
    }
  })
  proc.getState = async () => ({ model: { name: 'final-model' } })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  session.updateCachedPiState({ model: { name: 'stale-model' } })

  proc.emit({ type: 'message_end', message: { role: 'assistant' } })
  await staleRefreshStarted

  await session.refreshUsageTelemetry({ includeState: true, force: true })
  releaseStaleRefresh()
  await wait(25)

  const usageUpdates = conn.updates.filter(entry => entry.update.sessionUpdate === 'usage_update')
  assert.equal(statsCalls, 2)
  assert.deepEqual(
    usageUpdates.map(entry => entry.update),
    [{ sessionUpdate: 'usage_update', used: 150, size: 1000, cost: { amount: 0.1, currency: 'USD' } }]
  )
  assert.equal(conn.extNotifications.length, 1)
  assert.deepEqual(conn.extNotifications[0]!.params, {
    sessionId: 's1',
    usage: {
      context: { usedTokens: 150, maxTokens: 1000 },
      totals: { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
      cost: { amount: 0.1, currency: 'USD' },
      model: { name: 'final-model' }
    }
  })
})

test('PiAcpSession: emits exactly start and terminal updates for a normal live tool', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).title, 'bash')
  assert.equal((conn.updates[1]!.update as any).kind, 'execute')
  assert.equal((conn.updates[1]!.update as any).status, 'completed')
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: resolve(process.cwd(), 'src/acp/session.ts') }])
})

test('PiAcpSession: emits extension UI notify requests as sanitized custom notifications', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui1',
    method: 'notify',
    notifyType: 'warning',
    message: '\u001b[31mworking\u001b[0m'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 0)
  assert.deepEqual(conn.extNotifications, [
    {
      method: '_pi/extension_ui_event',
      params: {
        sessionId: 's1',
        method: 'notify',
        id: 'ui1',
        event: 'notify',
        notifyType: 'warning',
        level: 'warning',
        message: 'working'
      }
    }
  ])
})

test('PiAcpSession: emits extension UI status clears as custom notifications without transcript text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui2', method: 'setStatus', statusKey: 'cache-watch' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 0)
  assert.deepEqual(conn.extNotifications, [
    {
      method: '_pi/extension_ui_event',
      params: {
        sessionId: 's1',
        method: 'setStatus',
        id: 'ui2',
        event: 'status',
        statusKey: 'cache-watch',
        cleared: true
      }
    }
  ])
})

test('PiAcpSession: preserves extension UI widget clear semantics in custom notifications', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui3', method: 'setWidget', widgetKey: 'tasks' })
  proc.emit({ type: 'extension_ui_request', id: 'ui4', method: 'setWidget', widgetKey: 'tasks', widgetLines: [] })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 0)
  assert.deepEqual(conn.extNotifications, [
    {
      method: '_pi/extension_ui_event',
      params: {
        sessionId: 's1',
        method: 'setWidget',
        id: 'ui3',
        event: 'widget',
        widgetKey: 'tasks',
        cleared: true
      }
    },
    {
      method: '_pi/extension_ui_event',
      params: {
        sessionId: 's1',
        method: 'setWidget',
        id: 'ui4',
        event: 'widget',
        widgetKey: 'tasks',
        widgetLines: []
      }
    }
  ])
})

test('PiAcpSession: auto-cancels unsupported extension UI dialogs without transcript text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'dialog1', method: 'confirm', title: '\u001b[33mProceed?\u001b[0m' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'dialog1', payload: { confirmed: false } }])
  assert.deepEqual(conn.extNotifications, [
    {
      method: '_pi/extension_ui_event',
      params: {
        sessionId: 's1',
        method: 'confirm',
        id: 'dialog1',
        event: 'dialog',
        dialogType: 'confirm',
        title: 'Proceed?'
      }
    }
  ])
})

test('PiAcpSession: waits for extension UI custom notifications before resolving prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let releaseNotification!: () => void
  conn.extNotificationBlocker = new Promise(resolve => {
    releaseNotification = resolve
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ui1', method: 'notify', message: 'working' })
  proc.emit({ type: 'agent_end' })
  await new Promise(r => setTimeout(r, 0))

  assert.equal(resolved, false)
  releaseNotification()

  const reason = await p
  assert.equal(reason, 'end_turn')
  assert.equal(conn.extNotifications.length, 1)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: ignores streamed toolcall message updates while preserving text and thought', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 't1', name: 'write', arguments: { path: '/tmp/test.txt', content: 'hello' } }
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: { id: 't1', partialArgs: '{"content":"hello world"}' }
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: { id: 't1' }
    }
  })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }
    ]
  )
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'tool_call'),
    false
  )
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'tool_call_update'),
    false
  )
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt resolves end_turn on agent_end, not prompt ack', async () => {
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

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: prompt rejects and surfaces message when pi prompt fails', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.promptError = new Error('pi RPC prompt timed out after 30000ms')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  await assert.rejects(() => session.prompt('hello'), /Pi prompt failed: pi RPC prompt timed out after 30000ms/)
  await new Promise(r => setTimeout(r, 0))

  assert.ok(
    conn.updates.some(
      msg =>
        msg.update.sessionUpdate === 'agent_message_chunk' &&
        (msg.update as any).content.text === 'Pi prompt failed: pi RPC prompt timed out after 30000ms'
    )
  )
})

test('PiAcpSession: cancel overrides an in-progress prompt failure completion', async () => {
  const conn = new FakeAgentSideConnection()
  let unblockSessionUpdates!: () => void
  conn.sessionUpdateBlocker = new Promise(resolve => {
    unblockSessionUpdates = resolve
  })
  const proc = new FakePiRpcProcess()
  proc.promptError = new Error('socket hang up')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('hello')

  try {
    for (let i = 0; i < 10 && !(session as any).completingTurn; i += 1) await wait(0)
    assert.equal((session as any).completingTurn, true)

    const cancel = session.cancel()
    await wait(0)
    unblockSessionUpdates()
    await cancel

    const reason = await prompt
    assert.equal(reason, 'cancelled')
    assert.equal(proc.abortCount, 1)
    assert.ok(
      conn.updates.some(
        msg =>
          msg.update.sessionUpdate === 'agent_message_chunk' &&
          (msg.update as any).content.text === 'Pi prompt failed: socket hang up'
      )
    )
  } finally {
    unblockSessionUpdates()
  }
})

test('PiAcpSession: prompt resolves when an extension command returns without agent_end', async () => {
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

  const p = session.prompt('/cache-watch status')
  await new Promise(r => setTimeout(r, 125))
  const reason = await p
  assert.equal(reason, 'end_turn')
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: workflow slash prompt stays pending until workflow run_end', async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-agent-'))
  process.env.PI_CODING_AGENT_DIR = agentDir

  try {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-cwd-'))
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = new PiAcpSession({
      sessionId: 's1',
      cwd,
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    let resolved = false
    const prompt = session.prompt('/workflow:review task').then(reason => {
      resolved = true
      return reason
    })

    const workflowRunsDir = join(agentDir, 'workflow-runs')
    const runDir = join(workflowRunsDir, 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        id: 'r1',
        workflowId: 'review',
        commandName: 'workflow:review',
        cwd,
        initialTaskMessage: 'task',
        parentSessionId: 's1'
      }),
      'utf8'
    )
    const eventsPath = join(runDir, 'events.jsonl')
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'review', commandName: 'workflow:review', cwd, status: 'running' })}\n`,
      'utf8'
    )

    await wait(550)
    assert.equal(resolved, false)

    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'r1', workflowId: 'review', commandName: 'workflow:review', cwd, status: 'completed' })}\n`
    )

    const reason = await prompt
    assert.equal(reason, 'end_turn')
    assert.ok(conn.updates.some(msg => msg.update.sessionUpdate === 'tool_call_update'))
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('PiAcpSession: cancel interrupts a workflow prompt waiting for run_end', async () => {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-agent-'))
  process.env.PI_CODING_AGENT_DIR = agentDir

  try {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-cwd-'))
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()
    const session = new PiAcpSession({
      sessionId: 's1',
      cwd,
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    const prompt = session.prompt('/workflow:review task')

    const workflowRunsDir = join(agentDir, 'workflow-runs')
    const runDir = join(workflowRunsDir, 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        id: 'r1',
        workflowId: 'review',
        commandName: 'workflow:review',
        cwd,
        initialTaskMessage: 'task',
        parentSessionId: 's1',
        status: 'running'
      }),
      'utf8'
    )
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'review', commandName: 'workflow:review', cwd, status: 'running' })}\n`,
      'utf8'
    )

    await wait(200)
    await session.cancel()
    const reason = await Promise.race([prompt, wait(500).then(() => 'timeout')])

    assert.equal(proc.abortCount, 1)
    assert.equal(reason, 'cancelled')
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
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

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_end', async () => {
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

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: queued prompt starts after command-only prompt completes', async () => {
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

  const first = session.prompt('/cache-watch status')
  const second = session.prompt('two')

  const r1 = await first
  assert.equal(r1, 'end_turn')
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
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

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: defers unnamed streamed tool calls and corrects metadata on execution start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: { id: 't1', partialArgs: '{"pattern":"x"}' }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'grep', args: { pattern: 'x' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'grep')
  assert.equal((conn.updates[0]!.update as any).kind, 'search')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
})

test('PiAcpSession: execution start ignores prior streamed tool title and kind', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 't1', function: { name: 'read' }, partialArgs: '{"path":"a.txt"}' }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { cmd: 'ls' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).title, 'bash')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
})
