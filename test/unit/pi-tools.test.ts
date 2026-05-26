import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_PRESENTATION_LIMITS,
  safePresentationValue,
  toolResultToPresentationText,
  toolResultToText
} from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({ details: { diff: '--- a\n+++ b\n' } })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultToPresentationText: explicitly truncates large bash output', () => {
  const text = toolResultToPresentationText(
    { details: { stdout: 'x'.repeat(TOOL_PRESENTATION_LIMITS.textBytes + 100) } },
    { toolCallId: 't1' }
  )
  assert.ok(text.length < TOOL_PRESENTATION_LIMITS.textBytes + 200)
  assert.match(text, /presentation truncated/)
  assert.match(text, /tool t1/)
})

test('safePresentationValue: replaces large and cyclic raw values with diagnostic payloads', () => {
  const large = safePresentationValue(
    { output: 'x'.repeat(TOOL_PRESENTATION_LIMITS.rawJsonBytes + 1) },
    { toolCallId: 'large' }
  ) as any
  assert.equal(large.piAcpPresentation.truncated, true)
  assert.match(large.piAcpPresentation.reason, /too large/)

  const cyclic: any = { ok: true }
  cyclic.self = cyclic
  const safe = safePresentationValue(cyclic, { toolCallId: 'cyclic' }) as any
  assert.deepEqual(safe, { ok: true, self: '[Circular]' })
})
