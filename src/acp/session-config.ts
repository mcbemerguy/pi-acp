import { RequestError, type SessionConfigOption } from '@agentclientprotocol/sdk'
import type { PiRpcProcess } from '../pi-rpc/process.js'

export const MODEL_CONFIG_ID = 'model'
export const THINKING_CONFIG_ID = 'thinking_level'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as string[]).includes(value)
}

export async function getSessionConfigOptions(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<SessionConfigOption[]> {
  const [state, availableModels] = await Promise.all([resolveState(proc, pre), resolveAvailableModels(proc, pre)])

  const options: SessionConfigOption[] = []
  const modelOption = buildModelConfigOption(state, availableModels)
  if (modelOption) options.push(modelOption)
  options.push(buildThinkingConfigOption(state))

  return options
}

async function resolveState(proc: PiRpcProcess, pre?: { state?: any | null }): Promise<any | null> {
  if (pre && 'state' in pre) return pre.state ?? null

  try {
    return (await proc.getState()) as any
  } catch {
    return null
  }
}

async function resolveAvailableModels(proc: PiRpcProcess, pre?: { availableModels?: any | null }): Promise<any | null> {
  if (pre && 'availableModels' in pre) return pre.availableModels ?? null

  try {
    return (await proc.getAvailableModels()) as any
  } catch {
    return null
  }
}

function buildModelConfigOption(state: any | null, availableModels: any | null): SessionConfigOption | null {
  const rawModels: any[] = Array.isArray(availableModels?.models) ? availableModels.models : []
  const seen = new Set<string>()
  const options = rawModels
    .map(model => {
      const provider = String(model?.provider ?? '').trim()
      const id = String(model?.id ?? '').trim()
      if (!provider || !id) return null

      const value = formatModelValue(provider, id)
      if (seen.has(value)) return null
      seen.add(value)

      const name = String(model?.name ?? id).trim() || id
      const description = typeof model?.description === 'string' && model.description.trim() ? model.description : null

      return {
        value,
        name: `${provider}/${name}`,
        description
      }
    })
    .filter(Boolean) as Array<{ value: string; name: string; description: string | null }>

  const currentValue = currentModelValue(state)

  if (currentValue && !seen.has(currentValue)) {
    options.push({ value: currentValue, name: currentValue, description: null })
    seen.add(currentValue)
  }

  const selectedValue = currentValue && seen.has(currentValue) ? currentValue : (options[0]?.value ?? null)
  if (!selectedValue) return null

  return {
    id: MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: selectedValue,
    options,
    description: null
  }
}

function buildThinkingConfigOption(state: any | null): SessionConfigOption {
  const raw = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : ''
  const currentValue = isThinkingLevel(raw) ? raw : 'medium'

  return {
    id: THINKING_CONFIG_ID,
    name: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: THINKING_LEVELS.map(value => ({
      value,
      name: titleCase(value),
      description: null
    })),
    description: null
  }
}

function currentModelValue(state: any | null): string | null {
  const model = state?.model
  if (!model || typeof model !== 'object') return null

  const provider = String(model.provider ?? '').trim()
  const id = String(model.id ?? '').trim()
  if (!provider || !id) return null

  return formatModelValue(provider, id)
}

function formatModelValue(provider: string, modelId: string): string {
  return `${provider}/${modelId}`
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export async function resolveModelSelection(
  proc: PiRpcProcess,
  value: string
): Promise<{ provider: string; modelId: string }> {
  const trimmed = value.trim()

  if (trimmed.includes('/')) {
    const slash = trimmed.indexOf('/')
    const provider = trimmed.slice(0, slash).trim()
    const modelId = trimmed.slice(slash + 1).trim()
    if (provider && modelId) return { provider, modelId }
  } else if (trimmed) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(model => String(model?.id ?? '').trim() === trimmed)
    const provider = String(found?.provider ?? '').trim()
    const modelId = String(found?.id ?? '').trim()
    if (provider && modelId) return { provider, modelId }
  }

  throw RequestError.invalidParams(`Unknown model value: ${value}`)
}
