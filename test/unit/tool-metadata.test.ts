import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolKind } from '../../src/acp/translate/tool-metadata.js'

test('toToolKind: maps file discovery tools to search', () => {
  assert.equal(toToolKind('grep'), 'search')
  assert.equal(toToolKind('find'), 'search')
  assert.equal(toToolKind('ls'), 'search')
})
