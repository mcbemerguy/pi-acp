import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findPiSessionFile, listPiSessions, resolveStoredPiSessionFile } from '../../src/acp/pi-sessions.js'
import type { StoredSession } from '../../src/acp/session-store.js'

function withPiAgentDir<T>(root: string, fn: () => T): T {
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  try {
    return fn()
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
}

function writeSessionFile(
  path: string,
  input: { id: string; cwd: string; index: number; large?: boolean; title?: string }
) {
  const timestamp = `2026-01-01T00:${String(input.index).padStart(2, '0')}:00.000Z`
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: input.id,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: input.cwd
    }),
    JSON.stringify({
      type: 'session_info',
      id: `${input.id}-info`,
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      name: input.title ?? `Title ${input.id}`
    }),
    JSON.stringify({
      type: 'message',
      id: `${input.id}-message`,
      parentId: null,
      timestamp,
      message: { role: 'user', content: `Message ${input.id}` }
    })
  ]

  if (input.large) {
    const filler = JSON.stringify({
      type: 'message',
      id: `${input.id}-filler`,
      parentId: null,
      timestamp,
      message: { role: 'assistant', content: 'x'.repeat(2000) }
    })
    lines.splice(2, 0, ...Array.from({ length: 400 }, () => filler))
  }

  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

test('listPiSessions filters and paginates before expensive page title fallback while preserving metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-list-scale-'))
  const dir = join(root, 'sessions', '--repo--')
  const otherDir = join(root, 'sessions', '--other--')
  mkdirSync(dir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })

  for (let i = 0; i < 55; i++) {
    const id = `repo-${String(i).padStart(2, '0')}`
    writeSessionFile(join(dir, `${id}.jsonl`), { id, cwd: '/repo', index: 54 - i, large: i >= 50 })
  }
  writeSessionFile(join(otherDir, 'other.jsonl'), { id: 'other', cwd: '/other', index: 59 })

  withPiAgentDir(root, () => {
    const firstPage = listPiSessions({ cwd: '/repo', cursor: null, limit: 10 })
    assert.equal(firstPage.length, 10)
    assert.equal(firstPage[0]?.sessionId, 'repo-00')
    assert.equal(firstPage[9]?.sessionId, 'repo-09')
    assert.ok(firstPage.every(session => session.cwd === '/repo'))
    assert.equal(firstPage[0]?.updatedAt, '2026-01-01T00:54:00.000Z')

    const lastPage = listPiSessions({ cwd: '/repo', cursor: '50', limit: 10 })
    assert.equal(lastPage.length, 5)
    assert.equal(lastPage[0]?.sessionId, 'repo-50')
    assert.equal(lastPage[0]?.title, 'Title repo-50')
  })
})

test('session file resolution falls back after ACP-created mapping path is renamed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-list-renamed-'))
  const dir = join(root, 'sessions', '--repo--')
  mkdirSync(dir, { recursive: true })

  const oldPath = join(dir, 'old-name.jsonl')
  const newPath = join(dir, 'new-name.jsonl')
  writeSessionFile(oldPath, { id: 'renamed-session', cwd: '/repo', index: 1 })
  renameSync(oldPath, newPath)

  const stored: StoredSession = {
    sessionId: 'renamed-session',
    cwd: '/repo',
    sessionFile: oldPath,
    updatedAt: '2026-01-01T00:00:00.000Z'
  }

  withPiAgentDir(root, () => {
    assert.equal(resolveStoredPiSessionFile(stored), null)
    assert.equal(findPiSessionFile('renamed-session'), newPath)

    const listed = listPiSessions({ cwd: '/repo', storedSessions: [stored] })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.sessionId, 'renamed-session')
    assert.equal(listed[0]?.sessionFile, newPath)
  })
})
