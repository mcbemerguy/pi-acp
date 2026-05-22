import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export function toToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase()

  if (normalized === 'read') return 'read'
  if (normalized === 'write' || normalized === 'edit') return 'edit'
  if (normalized === 'bash') return 'execute'
  if (normalized === 'grep' || normalized === 'find') return 'search'
  if (normalized.startsWith('web_fetch') || normalized.startsWith('browser_fetch')) return 'fetch'

  return 'other'
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
