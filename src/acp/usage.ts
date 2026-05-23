import type { SessionUpdate, Usage } from '@agentclientprotocol/sdk'

export const PI_USAGE_UPDATE_METHOD = '_pi/session_usage_update'

type RecordValue = Record<string, unknown>

export type PiUsageTelemetry = {
  context?: {
    usedTokens?: number
    maxTokens?: number
  }
  totals?: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
  }
  lastRequest?: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
  }
  cost?: {
    amount: number
    currency: string
  }
  model?: {
    name?: string
    provider?: string
    effort?: string
  }
  cache?: {
    status?: string
  }
  autoCompaction?: {
    enabled?: boolean
  }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nestedRecord(root: RecordValue, key: string): RecordValue | undefined {
  const value = root[key]
  return isRecord(value) ? value : undefined
}

function firstNonNegativeInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = nonNegativeInt(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

function firstPositiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = positiveInt(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return undefined
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0
}

export function usageFromPiSessionStats(stats: unknown): Usage | undefined {
  if (!isRecord(stats)) return undefined
  const tokens = nestedRecord(stats, 'tokens')
  if (!tokens) return undefined

  const inputTokens = firstNonNegativeInt(tokens.input, tokens.inputTokens)
  const outputTokens = firstNonNegativeInt(tokens.output, tokens.outputTokens)
  const cachedReadTokens = firstNonNegativeInt(tokens.cacheRead, tokens.cachedReadTokens)
  const cachedWriteTokens = firstNonNegativeInt(tokens.cacheWrite, tokens.cachedWriteTokens)
  const thoughtTokens = firstNonNegativeInt(
    tokens.thought,
    tokens.thoughtTokens,
    tokens.reasoning,
    tokens.reasoningTokens
  )
  const totalTokens = firstNonNegativeInt(tokens.total, tokens.totalTokens)

  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) + (thoughtTokens ?? 0)
  const total = totalTokens ?? (derivedTotal > 0 ? derivedTotal : undefined)
  if (total === undefined || total <= 0) return undefined

  return {
    totalTokens: total,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {})
  }
}

function contextFromPiSessionStats(stats: RecordValue): NonNullable<PiUsageTelemetry['context']> | undefined {
  const contextUsage = nestedRecord(stats, 'contextUsage')
  const context = nestedRecord(stats, 'context') ?? nestedRecord(stats, 'contextWindow')
  const model = nestedRecord(stats, 'model')
  const usedTokens = firstNonNegativeInt(
    contextUsage?.tokens,
    contextUsage?.used,
    contextUsage?.usedTokens,
    context?.used,
    context?.usedTokens,
    stats.usedTokens,
    stats.contextUsed
  )
  const maxTokens = firstPositiveInt(
    contextUsage?.contextWindow,
    contextUsage?.size,
    contextUsage?.maxTokens,
    context?.size,
    context?.maxTokens,
    context?.contextWindow,
    stats.contextSize,
    stats.contextWindow,
    stats.maxTokens,
    model?.contextWindow,
    model?.maxTokens
  )
  return usedTokens !== undefined || maxTokens !== undefined
    ? {
        ...(usedTokens !== undefined ? { usedTokens } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {})
      }
    : undefined
}

function tokenDetailsFromRecord(tokens: RecordValue | undefined): NonNullable<PiUsageTelemetry['totals']> | undefined {
  if (!tokens) return undefined
  const inputTokens = firstNonNegativeInt(tokens.input, tokens.inputTokens)
  const outputTokens = firstNonNegativeInt(tokens.output, tokens.outputTokens)
  const cachedReadTokens = firstNonNegativeInt(tokens.cacheRead, tokens.cachedReadTokens)
  const cachedWriteTokens = firstNonNegativeInt(tokens.cacheWrite, tokens.cachedWriteTokens)
  const reasoningTokens = firstNonNegativeInt(
    tokens.thought,
    tokens.thoughtTokens,
    tokens.reasoning,
    tokens.reasoningTokens
  )
  const totalTokens = firstNonNegativeInt(tokens.total, tokens.totalTokens)
  const details = {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {})
  }
  return hasKeys(details) ? details : undefined
}

export function piUsageTelemetryFromPiSessionStats(stats: unknown): PiUsageTelemetry | undefined {
  if (!isRecord(stats)) return undefined
  const tokens = nestedRecord(stats, 'tokens')
  const lastTokens =
    nestedRecord(stats, 'lastRequest') ?? nestedRecord(stats, 'lastTurn') ?? nestedRecord(stats, 'lastUsage')
  const model = nestedRecord(stats, 'model')
  const cache = nestedRecord(stats, 'cache')
  const autoCompaction = nestedRecord(stats, 'autoCompaction') ?? nestedRecord(stats, 'compaction')

  const context = contextFromPiSessionStats(stats)
  const totals = tokenDetailsFromRecord(tokens)
  const lastRequest = tokenDetailsFromRecord(lastTokens) ?? totals
  const amount = finiteNonNegativeNumber(stats.cost)
  const currency = nonEmptyString(stats.currency) ?? (amount !== undefined ? 'USD' : undefined)
  const modelInfo = {
    ...((nonEmptyString(model?.name) ?? nonEmptyString(stats.model))
      ? { name: nonEmptyString(model?.name) ?? nonEmptyString(stats.model) }
      : {}),
    ...((nonEmptyString(model?.provider) ?? nonEmptyString(stats.provider))
      ? { provider: nonEmptyString(model?.provider) ?? nonEmptyString(stats.provider) }
      : {}),
    ...((nonEmptyString(model?.effort) ?? nonEmptyString(stats.effort) ?? nonEmptyString(stats.reasoningEffort))
      ? {
          effort: nonEmptyString(model?.effort) ?? nonEmptyString(stats.effort) ?? nonEmptyString(stats.reasoningEffort)
        }
      : {})
  }
  const cacheInfo = {
    ...((nonEmptyString(cache?.status) ?? nonEmptyString(stats.cacheStatus))
      ? { status: nonEmptyString(cache?.status) ?? nonEmptyString(stats.cacheStatus) }
      : {})
  }
  const autoCompactionEnabled = firstBoolean(autoCompaction?.enabled, autoCompaction?.automatic, stats.autoCompaction)
  const telemetry: PiUsageTelemetry = {
    ...(context ? { context } : {}),
    ...(totals ? { totals } : {}),
    ...(lastRequest ? { lastRequest } : {}),
    ...(amount !== undefined && currency !== undefined ? { cost: { amount, currency } } : {}),
    ...(hasKeys(modelInfo) ? { model: modelInfo } : {}),
    ...(hasKeys(cacheInfo) ? { cache: cacheInfo } : {}),
    ...(autoCompactionEnabled !== undefined ? { autoCompaction: { enabled: autoCompactionEnabled } } : {})
  }

  return hasKeys(telemetry) ? telemetry : undefined
}

export function usageUpdateFromPiSessionStats(stats: unknown): SessionUpdate | undefined {
  const telemetry = piUsageTelemetryFromPiSessionStats(stats)
  const used = telemetry?.context?.usedTokens
  const size = telemetry?.context?.maxTokens

  if (used === undefined || size === undefined) return undefined

  return {
    sessionUpdate: 'usage_update',
    used,
    size,
    ...(telemetry?.cost ? { cost: telemetry.cost } : {})
  }
}
