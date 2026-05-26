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

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function toolResultToPresentationText(result: unknown, source?: PresentationSource): string {
  return truncatePresentationText(toolResultToText(result), source)
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
  byteLimit: number
): { ok: true; text: string; bytes: number } | { ok: false; reason: string; bytes?: number } {
  const seen = new WeakSet<object>()
  let bytes = 0
  let exceeded = false
  try {
    const text = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return `${entry.toString()}n`
      if (typeof entry === 'function') return '[Function]'
      if (typeof entry === 'symbol') return String(entry)
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return '[Circular]'
        seen.add(entry)
      }
      if (typeof entry === 'string') {
        bytes += Buffer.byteLength(entry)
        if (bytes > byteLimit) {
          exceeded = true
          return '[Truncated]'
        }
      }
      return entry
    })
    const finalText = text ?? 'null'
    const finalBytes = exceeded ? Math.max(bytes, Buffer.byteLength(finalText)) : Buffer.byteLength(finalText)
    return { ok: true, text: finalText, bytes: finalBytes }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), bytes }
  }
}

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
