import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    return parsed
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export class SessionStore {
  private readonly path: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    const entry = db.sessions[sessionId] ?? null
    if (!entry) return null
    if (existsSync(entry.sessionFile)) return entry

    delete db.sessions[sessionId]
    saveFile(this.path, db)
    return null
  }

  list(): StoredSession[] {
    const db = loadFile(this.path)
    const sessions = Object.values(db.sessions).filter(entry => existsSync(entry.sessionFile))
    if (sessions.length !== Object.keys(db.sessions).length) {
      saveFile(this.path, { version: 1, sessions: Object.fromEntries(sessions.map(entry => [entry.sessionId, entry])) })
    }
    return sessions
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string }): void {
    const db = loadFile(this.path)
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: new Date().toISOString()
    }
    saveFile(this.path, db)
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}
