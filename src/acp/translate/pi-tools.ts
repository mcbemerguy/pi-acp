export type PresentationSource = {
  label?: string
  sessionId?: string
  toolCallId?: string
  eventType?: string
  sessionFile?: string | null
  workflow?: unknown
}

export const TOOL_PRESENTATION_LIMITS = {
  textBytes: 64 * 1024,
  rawJsonBytes: 128 * 1024,
  diffFileBytes: 256 * 1024
} as const

export function toolResultToText(result: unknown): string {
  const extracted = extractToolResultText(result)
  if (extracted !== undefined) return extracted

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function toolResultToPresentationText(result: unknown, source?: PresentationSource): string {
  const extracted = extractToolResultText(result)
  if (extracted !== undefined) return truncatePresentationText(extracted, source)

  const json = safeJsonStringify(result, TOOL_PRESENTATION_LIMITS.textBytes + 1, 2)
  if (json.ok && json.bytes <= TOOL_PRESENTATION_LIMITS.textBytes) return json.text

  return presentationDiagnostic(
    `JSON presentation omitted because ${json.ok ? 'it exceeded' : json.reason}; approx ${json.bytes ?? 'unknown'} bytes. Complete data remains in Pi/session/workflow artifacts`,
    source
  )
}

export function truncatePresentationText(text: string, source?: PresentationSource): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= TOOL_PRESENTATION_LIMITS.textBytes) return text
  const omitted = bytes - TOOL_PRESENTATION_LIMITS.textBytes
  return `${sliceUtf8(text, TOOL_PRESENTATION_LIMITS.textBytes)}\n\n[pi-acp: presentation truncated ${omitted} bytes from ${bytes} total bytes. Complete data remains in Pi/session/workflow artifacts${formatSourceSuffix(source)}.]`
}

export function presentationDiagnostic(message: string, source?: PresentationSource): string {
  return `[pi-acp: ${message}${formatSourceSuffix(source)}.]`
}

export function safePresentationValue(value: unknown, source?: PresentationSource): unknown {
  const json = safeJsonStringify(value, TOOL_PRESENTATION_LIMITS.rawJsonBytes + 1)
  if (!json.ok) {
    return presentationValueDiagnostic(json.reason, source, json.bytes)
  }
  if (json.bytes > TOOL_PRESENTATION_LIMITS.rawJsonBytes) {
    return presentationValueDiagnostic('raw JSON presentation too large', source, json.bytes)
  }
  try {
    return JSON.parse(json.text)
  } catch {
    return presentationValueDiagnostic('raw value is not JSON-replayable', source, json.bytes)
  }
}

function extractToolResultText(result: unknown): string | undefined {
  if (!result) return ''

  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  const details = (result as any)?.details

  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  return undefined
}

function presentationValueDiagnostic(
  reason: string,
  source: PresentationSource | undefined,
  approxJsonBytes?: number
): unknown {
  return {
    piAcpPresentation: {
      truncated: true,
      reason,
      ...(approxJsonBytes !== undefined ? { approxJsonBytes } : {}),
      completeData: 'Pi/session/workflow artifacts retain the source event data.',
      ...(source ? { source } : {})
    }
  }
}

function safeJsonStringify(
  value: unknown,
  byteLimit: number,
  space = 0
): { ok: true; text: string; bytes: number } | { ok: false; reason: string; bytes?: number } {
  const seen = new WeakSet<object>()
  const chunks: string[] = []
  let bytes = 0
  const indentUnit = typeof space === 'number' && space > 0 ? ' '.repeat(Math.min(space, 10)) : ''

  const append = (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > byteLimit) throw new JsonPresentationLimitExceeded()
    chunks.push(chunk)
  }

  const appendString = (value: string) => {
    const minBytes = Buffer.byteLength(value) + 2
    if (bytes + minBytes > byteLimit) {
      bytes += minBytes
      throw new JsonPresentationLimitExceeded()
    }
    const json = JSON.stringify(value)
    bytes += Buffer.byteLength(json)
    if (bytes > byteLimit) throw new JsonPresentationLimitExceeded()
    chunks.push(json)
  }

  const serialize = (entry: unknown, depth: number, inArray: boolean): boolean => {
    if (entry === undefined) {
      if (!inArray) return false
      append('null')
      return true
    }

    if (typeof entry === 'function') {
      appendString('[Function]')
      return true
    }

    if (typeof entry === 'symbol') {
      appendString(String(entry))
      return true
    }

    if (entry === null) {
      append('null')
      return true
    }

    if (typeof entry === 'string') {
      appendString(entry)
      return true
    }

    if (typeof entry === 'number') {
      append(Number.isFinite(entry) ? String(entry) : 'null')
      return true
    }

    if (typeof entry === 'boolean') {
      append(entry ? 'true' : 'false')
      return true
    }

    if (typeof entry === 'bigint') {
      appendString(`${entry.toString()}n`)
      return true
    }

    if (!entry || typeof entry !== 'object') {
      append('null')
      return true
    }

    if (seen.has(entry)) {
      appendString('[Circular]')
      return true
    }

    seen.add(entry)
    try {
      if (Array.isArray(entry)) {
        appendArray(entry, depth)
      } else {
        appendObject(entry as Record<string, unknown>, depth)
      }
    } finally {
      seen.delete(entry)
    }
    return true
  }

  const newlineAndIndent = (depth: number) => {
    if (!indentUnit) return
    append('\n')
    append(indentUnit.repeat(depth))
  }

  const appendArray = (array: unknown[], depth: number) => {
    append('[')
    for (let i = 0; i < array.length; i += 1) {
      if (i > 0) append(',')
      newlineAndIndent(depth + 1)
      serialize(array[i], depth + 1, true)
    }
    if (array.length > 0) newlineAndIndent(depth)
    append(']')
  }

  const appendObject = (object: Record<string, unknown>, depth: number) => {
    append('{')
    let emitted = 0
    for (const key of Object.keys(object)) {
      const beforeChunks = chunks.length
      const beforeBytes = bytes
      if (emitted > 0) append(',')
      newlineAndIndent(depth + 1)
      appendString(key)
      append(indentUnit ? ': ' : ':')
      const emittedValue = serialize(object[key], depth + 1, false)
      if (!emittedValue) {
        chunks.length = beforeChunks
        bytes = beforeBytes
        continue
      }
      emitted += 1
    }
    if (emitted > 0) newlineAndIndent(depth)
    append('}')
  }

  try {
    serialize(value, 0, false)
    return { ok: true, text: chunks.join(''), bytes }
  } catch (error) {
    if (error instanceof JsonPresentationLimitExceeded) {
      return { ok: false, reason: 'raw JSON presentation too large', bytes }
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error), bytes }
  }
}

class JsonPresentationLimitExceeded extends Error {}

function sliceUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.byteLength <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/�$/u, '')
}

function formatSourceSuffix(source?: PresentationSource): string {
  if (!source) return ''
  const parts = [
    source.label,
    source.sessionId ? `session ${source.sessionId}` : undefined,
    source.toolCallId ? `tool ${source.toolCallId}` : undefined,
    source.eventType,
    source.sessionFile ? `session file ${source.sessionFile}` : undefined
  ].filter(Boolean)
  return parts.length ? `; source: ${parts.join(', ')}` : ''
}
