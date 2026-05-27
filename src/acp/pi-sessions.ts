import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import type { StoredSession } from './session-store.js'
import { readJsonObjectCached } from './file-cache.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

export type PiSessionListOptions = {
  cwd?: string | null
  cursor?: string | null
  limit?: number
  storedSessions?: StoredSession[]
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024
const DEFAULT_INFO_SCAN_BYTES = 1024 * 1024

export type PiSessionHeader = { sessionId: string; cwd: string }
export type PiSessionFileValidation =
  | { ok: true; header: PiSessionHeader; sessionFile: string }
  | { ok: false; reason: 'missing' | 'empty' | 'invalid' | 'wrong-session' | 'wrong-cwd' }

type SessionHeader = PiSessionHeader
type SessionCandidate = SessionHeader & {
  sessionFile: string
  mtimeIso: string | null
  mtimeMs: number
  size: number
}
type TailInfo = { title: string | null; updatedAt: string | null }
type CachedTailInfo = { mtimeMs: number; size: number; info: TailInfo }

const tailInfoCache = new Map<string, CachedTailInfo>()

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const data = readJsonObjectCached(join(agentDir, 'settings.json'))
  const sessionDir = data.sessionDir
  if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

  return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): SessionHeader | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function scanSessionInfoNameFromRecentFileWindow(
  path: string,
  maxAdditionalBytes = DEFAULT_INFO_SCAN_BYTES
): string | null {
  try {
    return pickTitleFromTail(readTail(path, DEFAULT_TAIL_BYTES + maxAdditionalBytes))
  } catch {
    return null
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  const lines = tail.split(/\r?\n/)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function readHead(path: string, headBytes = DEFAULT_HEAD_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(headBytes)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickFallbackTitleFromHead(path: string): string | null {
  try {
    const raw = readHead(path)
    const lines = raw.split(/\r?\n/)
    for (const line0 of lines) {
      const line = line0.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as any
        if (obj?.type === 'message' && obj?.message?.role === 'user') {
          const content = obj?.message?.content
          if (typeof content === 'string') return content.slice(0, 80)
          if (Array.isArray(content)) {
            const t = content.find((c: any) => c?.type === 'text' && typeof c?.text === 'string')
            if (t?.text) return String(t.text).slice(0, 80)
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return null
}

export function validatePiSessionFile(
  file: string,
  expected?: { sessionId?: string | null; cwd?: string | null }
): PiSessionFileValidation {
  if (!existsSync(file)) return { ok: false, reason: 'missing' }

  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (size <= 0) return { ok: false, reason: 'empty' }

  const first = readFirstLine(file)
  if (!first) return { ok: false, reason: 'empty' }

  const header = parseSessionHeader(first)
  if (!header) return { ok: false, reason: 'invalid' }
  if (expected?.sessionId && header.sessionId !== expected.sessionId) return { ok: false, reason: 'wrong-session' }
  if (expected?.cwd && header.cwd !== expected.cwd) return { ok: false, reason: 'wrong-cwd' }

  return { ok: true, header, sessionFile: file }
}

function getCandidateFromFile(file: string): SessionCandidate | null {
  const validation = validatePiSessionFile(file)
  if (!validation.ok) return null

  try {
    const st = statSync(file)
    return {
      ...validation.header,
      sessionFile: file,
      mtimeIso: st.mtime.toISOString(),
      mtimeMs: st.mtimeMs,
      size: st.size
    }
  } catch {
    return null
  }
}

function collectStoredCandidates(
  storedSessions: StoredSession[] | undefined,
  seenFiles: Set<string>,
  cwd: string | null | undefined
): SessionCandidate[] {
  if (!storedSessions?.length) return []
  const out: SessionCandidate[] = []

  for (const stored of storedSessions) {
    if (cwd && stored.cwd !== cwd) continue
    if (!stored.sessionFile || seenFiles.has(stored.sessionFile)) continue
    const candidate = getCandidateFromFile(stored.sessionFile)
    if (!candidate || candidate.sessionId !== stored.sessionId) continue
    seenFiles.add(stored.sessionFile)
    out.push(candidate)
  }

  return out
}

function collectFallbackCandidates(seenFiles: Set<string>): SessionCandidate[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const out: SessionCandidate[] = []
  for (const file of files) {
    if (seenFiles.has(file)) continue
    const candidate = getCandidateFromFile(file)
    if (!candidate) continue
    seenFiles.add(file)
    out.push(candidate)
  }
  return out
}

function getTailInfo(candidate: SessionCandidate): TailInfo {
  const cached = tailInfoCache.get(candidate.sessionFile)
  if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) return cached.info

  try {
    const tail = readTail(candidate.sessionFile)
    const info = {
      title: pickTitleFromTail(tail),
      updatedAt: pickUpdatedAtFromTail(tail) ?? candidate.mtimeIso
    }
    tailInfoCache.set(candidate.sessionFile, { mtimeMs: candidate.mtimeMs, size: candidate.size, info })
    return info
  } catch {
    return { title: null, updatedAt: candidate.mtimeIso }
  }
}

function toOffset(cursor: string | null | undefined): number {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0
  return Number.isFinite(offset) && offset > 0 ? offset : 0
}

export function listPiSessions(options: PiSessionListOptions = {}): PiSessionListItem[] {
  const seenFiles = new Set<string>()
  const candidates = [
    ...collectStoredCandidates(options.storedSessions, seenFiles, options.cwd),
    ...collectFallbackCandidates(seenFiles)
  ].filter(candidate => !options.cwd || candidate.cwd === options.cwd)

  const tailInfo = new Map<string, TailInfo>()
  const updatedAtFor = (candidate: SessionCandidate): string | null => {
    let info = tailInfo.get(candidate.sessionFile)
    if (!info) {
      info = getTailInfo(candidate)
      tailInfo.set(candidate.sessionFile, info)
    }
    return info.updatedAt
  }

  candidates.sort((a, b) => (updatedAtFor(b) ?? '').localeCompare(updatedAtFor(a) ?? ''))

  const start = toOffset(options.cursor)
  const page =
    options.limit && options.limit > 0 ? candidates.slice(start, start + options.limit) : candidates.slice(start)

  return page.map(candidate => {
    let info = tailInfo.get(candidate.sessionFile)
    if (!info) {
      info = getTailInfo(candidate)
      tailInfo.set(candidate.sessionFile, info)
    }

    let title = info.title
    if (!title) title = scanSessionInfoNameFromRecentFileWindow(candidate.sessionFile)
    if (!title) title = pickFallbackTitleFromHead(candidate.sessionFile)

    return {
      sessionId: candidate.sessionId,
      cwd: candidate.cwd,
      title,
      updatedAt: info.updatedAt,
      sessionFile: candidate.sessionFile
    }
  })
}

export function findPiSessionFile(sessionId: string, cwd?: string | null): string | null {
  const seenFiles = new Set<string>()
  for (const candidate of collectFallbackCandidates(seenFiles)) {
    if (candidate.sessionId === sessionId && (!cwd || candidate.cwd === cwd)) return candidate.sessionFile
  }
  return null
}

export function resolveStoredPiSessionFile(
  stored: StoredSession | null,
  expected?: { cwd?: string | null }
): string | null {
  if (!stored) return null
  if (!stored.sessionFile || !isAbsolute(stored.sessionFile)) return null

  const cwd = expected?.cwd ?? stored.cwd
  const validation = validatePiSessionFile(stored.sessionFile, { sessionId: stored.sessionId, cwd })
  if (!validation.ok) return null

  return validation.sessionFile
}
