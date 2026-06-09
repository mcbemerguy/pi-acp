import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJsonObjectCached } from './file-cache.js'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v)
    else out[k] = v
  }
  return out
}

function getMergedSettings(cwd: string, opts: { includeProject?: boolean } = {}): Record<string, unknown> {
  const globalSettingsPath = join(getAgentDir(), 'settings.json')
  const projectSettingsPath = resolve(cwd, '.pi', 'settings.json')

  const global = readJsonObjectCached(globalSettingsPath)
  const project = opts.includeProject === true ? readJsonObjectCached(projectSettingsPath) : {}
  return deepMerge(global, project)
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

export function getEnableSkillCommands(cwd: string, opts: { includeProject?: boolean } = {}): boolean {
  const merged = getMergedSettings(cwd, opts)

  const direct = merged.enableSkillCommands
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined
  if (typeof nested === 'boolean') return nested

  return true
}
