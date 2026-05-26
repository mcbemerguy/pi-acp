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

test('safePresentationValue: preserves unserializable scalar diagnostics in small raw values', () => {
  const presented = safePresentationValue({ fn: () => undefined, sym: Symbol('x'), big: 1n }) as any

  assert.equal(presented.fn, '[Function]')
  assert.equal(presented.sym, 'Symbol(x)')
  assert.equal(presented.big, '1n')
})

test('safePresentationValue: stops numeric JSON presentation at the byte limit', () => {
  const raw = { rows: Array.from({ length: 100_000 }, (_, i) => i) }
  const presented = safePresentationValue(raw, { toolCallId: 'numbers' }) as any

  assert.equal(presented.piAcpPresentation.truncated, true)
  assert.match(presented.piAcpPresentation.reason, /too large/)
  assert.ok(presented.piAcpPresentation.approxJsonBytes <= TOOL_PRESENTATION_LIMITS.rawJsonBytes + 32)
  assert.equal(presented.piAcpPresentation.source.toolCallId, 'numbers')
})

test('toolResultToPresentationText: omits large structured JSON fallback without full presentation', () => {
  const text = toolResultToPresentationText(
    { rows: Array.from({ length: 100_000 }, (_, i) => i) },
    { toolCallId: 'structured' }
  )

  assert.match(text, /JSON presentation omitted/)
  assert.match(text, /tool structured/)
  assert.ok(Buffer.byteLength(text) < 512)
})
