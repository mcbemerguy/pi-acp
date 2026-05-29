import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/acp/session-store.js'

test('SessionStore: prunes mappings whose session files no longer exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-session-store-'))
  const mapPath = join(root, 'session-map.json')
  const existingSessionFile = join(root, 'existing.jsonl')
  const missingSessionFile = join(root, 'missing.jsonl')

  writeFileSync(existingSessionFile, '{}\n', 'utf8')
  writeFileSync(
    mapPath,
    JSON.stringify(
      {
        version: 1,
        sessions: {
          existing: {
            sessionId: 'existing',
            cwd: '/tmp/project',
            sessionFile: existingSessionFile,
            updatedAt: '2026-01-01T00:00:00.000Z'
          },
          missing: {
            sessionId: 'missing',
            cwd: '/tmp/project',
            sessionFile: missingSessionFile,
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      },
      null,
      2
    ) + '\n',
    'utf8'
  )

  const store = new SessionStore(mapPath)

  assert.equal(store.get('missing'), null)
  assert.deepEqual(
    store.list().map(entry => entry.sessionId),
    ['existing']
  )

  const persisted = JSON.parse(readFileSync(mapPath, 'utf8'))
  assert.deepEqual(Object.keys(persisted.sessions), ['existing'])
})
