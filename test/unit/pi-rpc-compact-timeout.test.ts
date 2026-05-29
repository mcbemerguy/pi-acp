import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPACT_REQUEST_TIMEOUT_MS } from '../../src/pi-rpc/process.js'

test('PiRpcProcess: manual compact uses the prompt-style unbounded timeout', () => {
  assert.equal(COMPACT_REQUEST_TIMEOUT_MS, 0)
})
