import type { SessionUpdate, Usage } from '@agentclientprotocol/sdk'

type RecordValue = Record<string, unknown>

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

export function usageUpdateFromPiSessionStats(stats: unknown): SessionUpdate | undefined {
  if (!isRecord(stats)) return undefined
  const tokens = nestedRecord(stats, 'tokens')
  const context = nestedRecord(stats, 'context') ?? nestedRecord(stats, 'contextWindow')
  const model = nestedRecord(stats, 'model')

  const used = firstPositiveInt(
    context?.used,
    context?.usedTokens,
    stats.usedTokens,
    stats.contextUsed,
    tokens?.context,
    tokens?.total,
    tokens?.totalTokens
  )
  const size = firstPositiveInt(
    context?.size,
    context?.maxTokens,
    context?.contextWindow,
    stats.contextSize,
    stats.contextWindow,
    stats.maxTokens,
    model?.contextWindow,
    model?.maxTokens
  )

  if (used === undefined || size === undefined) return undefined

  const currency = typeof stats.currency === 'string' && stats.currency.trim() ? stats.currency.trim() : undefined
  const amount =
    typeof stats.cost === 'number' && Number.isFinite(stats.cost) && stats.cost >= 0 ? stats.cost : undefined

  return {
    sessionUpdate: 'usage_update',
    used,
    size,
    ...(amount !== undefined && currency !== undefined ? { cost: { amount, currency } } : {})
  }
}
