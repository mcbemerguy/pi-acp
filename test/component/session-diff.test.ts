import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { TOOL_PRESENTATION_LIMITS } from '../../src/acp/translate/pi-tools.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits ACP diff content for edit tool when file changes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Start edit -> snapshot should be taken
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.txt' } })

  // Simulate file being edited by pi
  writeFileSync(filePath, 'after\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for edit completion')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')

  assert.equal(diff.path, 'a.txt')
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
})

test('PiAcpSession: omits structured diff for large files with explicit diagnostic', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-large-'))
  const filePath = join(dir, 'large.txt')
  writeFileSync(filePath, 'x'.repeat(TOOL_PRESENTATION_LIMITS.diffFileBytes + 1), 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't-large', toolName: 'edit', args: { path: 'large.txt' } })
  writeFileSync(filePath, 'y'.repeat(TOOL_PRESENTATION_LIMITS.diffFileBytes + 1), 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-large',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-large' && u.update.sessionUpdate === 'tool_call_update'
  )
  const content = (end!.update as any).content as any[]
  assert.ok(!content.some(c => c.type === 'diff'))
  assert.match(content[0].content.text, /structured diff omitted/)
})

test('PiAcpSession: truncates large tool output and raw output presentation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: mkdtempSync(join(tmpdir(), 'pi-acp-tool-large-')),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't-output',
    toolName: 'bash',
    isError: false,
    result: { details: { stdout: 'x'.repeat(TOOL_PRESENTATION_LIMITS.rawJsonBytes + 1) } }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't-output' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.match((end!.update as any).content[0].content.text, /presentation truncated/)
  assert.equal((end!.update as any).rawOutput.piAcpPresentation.truncated, true)
})
