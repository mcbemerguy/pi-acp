import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'

function withPiAgentDir<T>(root: string, run: () => T): T {
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  try {
    return run()
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

test('listPiSessions: fallback title reads only the bounded head chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const sessionFile = join(sessionsDir, 's.jsonl')
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-head-limit',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project'
  })
  const lateUser = JSON.stringify({
    type: 'message',
    id: 'm-late',
    parentId: null,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'user', content: 'Late title should not require scanning the full file' }
  })

  writeFileSync(sessionFile, `${header}\n${'x'.repeat(80 * 1024)}\n${lateUser}\n`, { encoding: 'utf8' })

  const s = withPiAgentDir(root, () => listPiSessions().find(x => x.sessionId === 'sess-head-limit'))
  assert.ok(s)
  assert.equal(s?.title, null)
})
