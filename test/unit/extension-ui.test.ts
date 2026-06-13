import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { buildPiRpcSpawnEnv } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
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

  return { conn, proc, session }
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('PiAcpSession: translates select extension UI requests to cursor/ask_question and returns labels', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({ answers: { selection: 'Banana' } })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Question 1/1: Pick a fruit',
    options: ['Apple', 'Banana']
  })

  await flushAsyncHandlers()

  assert.equal(conn.extensionRequests.length, 1)
  assert.equal(conn.extensionRequests[0]!.method, 'cursor/ask_question')
  assert.deepEqual(conn.extensionRequests[0]!.params, {
    toolCallId: 'ui-1',
    title: 'Question 1/1: Pick a fruit',
    questions: [
      {
        id: 'selection',
        prompt: 'Question 1/1: Pick a fruit',
        options: [
          { id: '0', label: 'Apple' },
          { id: '1', label: 'Banana' }
        ],
        allowMultiple: false
      }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', payload: { value: 'Banana' } }])
})

test('PiAcpSession: maps select answer ids back to option labels and preserves custom strings', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({ answers: { selection: '1' } })
  conn.queueExtensionResponse({ answers: { selection: 'Something else' } })

  proc.emit({ type: 'extension_ui_request', id: 'ui-id', method: 'select', title: 'Choose', options: ['One', 'Two'] })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-custom',
    method: 'select',
    title: 'Choose',
    options: ['One', 'Two']
  })

  await flushAsyncHandlers()

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-id', payload: { value: 'Two' } },
    { id: 'ui-custom', payload: { value: 'Something else' } }
  ])
})

test('PiAcpSession: hides Pi generated Other option so T3Code composer custom answers resolve select dialogs', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({ answers: { selection: 'Dragonfruit' } })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-custom-answer',
    method: 'select',
    title: 'Choose',
    options: ['Apple', 'Banana', 'Other (type your own answer)']
  })

  await flushAsyncHandlers()

  assert.deepEqual(conn.extensionRequests[0]!.params, {
    toolCallId: 'ui-custom-answer',
    title: 'Choose',
    questions: [
      {
        id: 'selection',
        prompt: 'Choose',
        options: [
          { id: '0', label: 'Apple' },
          { id: '1', label: 'Banana' }
        ],
        allowMultiple: false
      }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-custom-answer', payload: { value: 'Dragonfruit' } }])
})

test('PiAcpSession: translates input extension UI requests to cursor/ask_question and returns text', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({ answers: { value: 'custom answer' } })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'input',
    title: 'Question 1/1: Type your answer',
    placeholder: 'Type your answer...'
  })

  await flushAsyncHandlers()

  assert.equal(conn.extensionRequests.length, 1)
  assert.equal(conn.extensionRequests[0]!.method, 'cursor/ask_question')
  assert.deepEqual(conn.extensionRequests[0]!.params, {
    toolCallId: 'ui-2',
    title: 'Question 1/1: Type your answer',
    questions: [
      {
        id: 'value',
        prompt: 'Question 1/1: Type your answer\nType your answer...',
        allowMultiple: false
      }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', payload: { value: 'custom answer' } }])
})

test('PiAcpSession: never deadlocks Pi on unsupported, malformed, or failing extension UI requests', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({})
  conn.queueExtensionResponse(new Error('client does not support questions'))

  proc.emit({ type: 'extension_ui_request', id: 'unsupported', method: 'datepicker', title: 'Pick a date' })
  proc.emit({ type: 'extension_ui_request', id: 'missing-method', title: 'Choose' })
  proc.emit({ type: 'extension_ui_request', id: 'invalid-method', method: 42, title: 'Choose' })
  proc.emit({ type: 'extension_ui_request', id: 'malformed', method: 'select', title: 'Choose', options: ['A'] })
  proc.emit({ type: 'extension_ui_request', id: 'failing', method: 'input', title: 'Type' })

  await flushAsyncHandlers()

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'unsupported', payload: { cancelled: true } },
    { id: 'missing-method', payload: { cancelled: true } },
    { id: 'invalid-method', payload: { cancelled: true } },
    { id: 'malformed', payload: { cancelled: true } },
    { id: 'failing', payload: { cancelled: true } }
  ])
})

test('PiAcpSession: confirm failures unblock Pi with confirmed false', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse(new Error('unsupported'))

  proc.emit({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Continue?' })

  await flushAsyncHandlers()

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'confirm-1', payload: { confirmed: false } }])
})

test('PiAcpSession: editor requests include Pi prefill text when asking the client', async () => {
  const { conn, proc } = makeSession()
  conn.queueExtensionResponse({ answers: { value: 'edited text' } })

  proc.emit({
    type: 'extension_ui_request',
    id: 'editor-1',
    method: 'editor',
    title: 'Edit answer',
    prefill: 'existing text',
    text: 'stale text'
  })

  await flushAsyncHandlers()

  assert.deepEqual(conn.extensionRequests[0]!.params, {
    toolCallId: 'editor-1',
    title: 'Edit answer',
    questions: [
      {
        id: 'value',
        prompt: 'Edit answer\n\nexisting text',
        allowMultiple: false
      }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'editor-1', payload: { value: 'edited text' } }])
})

test('PiAcpSession: extension UI requests do not resolve prompt turns before agent_end', async () => {
  const { conn, proc, session } = makeSession()
  conn.queueExtensionResponse({ answers: { selection: 'Yes' } })

  let resolved = false
  const promptResult = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  await flushAsyncHandlers()

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-turn',
    method: 'select',
    title: 'Continue?',
    options: ['Yes', 'No']
  })
  await flushAsyncHandlers()

  assert.equal(resolved, false)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-turn', payload: { value: 'Yes' } }])

  proc.emit({ type: 'agent_end' })
  assert.equal(await promptResult, 'end_turn')
  assert.equal(resolved, true)
})

test('PiRpcProcess: ACP RPC marker does not imply global ask_user_questions tool enablement', () => {
  const marked = buildPiRpcSpawnEnv({ PATH: '/bin', PI_DELEGATED_TOOL_CAP: 'read,bash' })
  const stripped = buildPiRpcSpawnEnv({ PATH: '/bin', PI_DELEGATED_TOOL_CAP: 'read,ask_user_questions,bash' })
  const removed = buildPiRpcSpawnEnv({ PATH: '/bin', PI_DELEGATED_TOOL_CAP: 'ask_user_questions' })

  assert.equal(marked.PI_ACP_RPC, '1')
  assert.equal(marked.PI_DELEGATED_TOOL_CAP, 'read,bash')
  assert.equal(stripped.PI_DELEGATED_TOOL_CAP, 'read,bash')
  assert.equal(removed.PI_DELEGATED_TOOL_CAP, undefined)
  assert.equal(buildPiRpcSpawnEnv({ PATH: '/bin' }).PI_DELEGATED_TOOL_CAP, undefined)
})
