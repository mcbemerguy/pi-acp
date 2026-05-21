import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'other'
    default:
      return 'other'
  }
}

export function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
      ? (args as { path: string }).path
      : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}
