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

test('listPiSessions: session_info scan prioritizes recent names outside the default tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const sessionFile = join(sessionsDir, 's.jsonl')
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-recent-name',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project'
  })
  const earlyName = JSON.stringify({ type: 'session_info', name: 'Early stale name' })
  const recentName = JSON.stringify({ type: 'session_info', name: 'Recent correct name' })
  const recentMessage = JSON.stringify({
    type: 'message',
    id: 'm-recent',
    parentId: null,
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'assistant', content: 'ok' }
  })

  writeFileSync(
    sessionFile,
    `${header}\n${earlyName}\n${'x'.repeat(1100 * 1024)}\n${recentName}\n${'x'.repeat(300 * 1024)}\n${recentMessage}\n`,
    { encoding: 'utf8' }
  )

  const s = withPiAgentDir(root, () => listPiSessions().find(x => x.sessionId === 'sess-recent-name'))
  assert.ok(s)
  assert.equal(s?.title, 'Recent correct name')
})

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
