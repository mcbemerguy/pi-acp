import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAcpInputLine } from '../../src/acp/t3code-compat.js'

test('leaves t3code request-shaped session/cancel untouched so clients receive a response', () => {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: { sessionId: 's1' },
    id: '',
    headers: []
  })

  assert.equal(normalizeAcpInputLine(line), line)
})

test('leaves valid ACP notifications untouched', () => {
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } })
  assert.equal(normalizeAcpInputLine(line), line)
})
