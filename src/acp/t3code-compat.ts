export function normalizeAcpInputLine(line: string): string {
  if (!line.trim()) return line

  try {
    const message = JSON.parse(line) as unknown
    if (!isObject(message)) return line

    if (message.jsonrpc === '2.0' && message.method === 'session/cancel' && 'id' in message) {
      const { id: _id, headers: _headers, ...notification } = message
      void _id
      void _headers
      return JSON.stringify(notification)
    }
  } catch {
    return line
  }

  return line
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
