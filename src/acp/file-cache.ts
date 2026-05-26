import { readFileSync, statSync } from 'node:fs'

export type FileMetadata = {
  mtimeNs: bigint
  ctimeNs: bigint
  size: bigint
}

export function statFile(path: string): FileMetadata | null {
  try {
    const st = statSync(path, { bigint: true })
    if (!st.isFile()) return null
    return { mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, size: st.size }
  } catch {
    return null
  }
}

type CachedTextFile = FileMetadata & {
  content: string | null
}

const textFileCache = new Map<string, CachedTextFile>()

export function readTextFileCached(path: string): string | null {
  const metadata = statFile(path)
  if (!metadata) {
    textFileCache.delete(path)
    return null
  }

  const cached = textFileCache.get(path)
  if (
    cached &&
    cached.mtimeNs === metadata.mtimeNs &&
    cached.ctimeNs === metadata.ctimeNs &&
    cached.size === metadata.size
  )
    return cached.content

  try {
    const content = readFileSync(path, 'utf-8')
    textFileCache.set(path, { ...metadata, content })
    return content
  } catch {
    textFileCache.set(path, { ...metadata, content: null })
    return null
  }
}

type CachedJsonObject = FileMetadata & {
  value: Record<string, unknown>
}

const jsonObjectCache = new Map<string, CachedJsonObject>()

export function readJsonObjectCached(path: string): Record<string, unknown> {
  const metadata = statFile(path)
  if (!metadata) {
    jsonObjectCache.delete(path)
    return {}
  }

  const cached = jsonObjectCache.get(path)
  if (
    cached &&
    cached.mtimeNs === metadata.mtimeNs &&
    cached.ctimeNs === metadata.ctimeNs &&
    cached.size === metadata.size
  )
    return cached.value

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    const value = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
    jsonObjectCache.set(path, { ...metadata, value })
    return value
  } catch {
    const value: Record<string, unknown> = {}
    jsonObjectCache.set(path, { ...metadata, value })
    return value
  }
}
