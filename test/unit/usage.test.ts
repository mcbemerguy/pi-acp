import test from 'node:test'
import assert from 'node:assert/strict'
import {
  piUsageTelemetryFromPiSessionStats,
  usageFromPiSessionStats,
  usageUpdateFromPiSessionStats
} from '../../src/acp/usage.js'

test('usageUpdateFromPiSessionStats uses current contextUsage instead of cumulative tokens', () => {
  const update = usageUpdateFromPiSessionStats({
    tokens: {
      input: 50_000,
      output: 10_000,
      cacheRead: 40_000,
      cacheWrite: 5_000,
      total: 105_000
    },
    contextUsage: {
      tokens: 60_000,
      contextWindow: 200_000,
      percent: 30
    }
  })

  assert.deepEqual(update, {
    sessionUpdate: 'usage_update',
    used: 60_000,
    size: 200_000
  })
})

test('usageUpdateFromPiSessionStats omits update when contextUsage has no fresh used tokens', () => {
  const update = usageUpdateFromPiSessionStats({
    tokens: { total: 105_000 },
    contextUsage: {
      tokens: null,
      contextWindow: 200_000,
      percent: null
    }
  })

  assert.equal(update, undefined)
})

test('usageFromPiSessionStats keeps cumulative token accounting for prompt usage', () => {
  const usage = usageFromPiSessionStats({
    tokens: {
      input: 50_000,
      output: 10_000,
      cacheRead: 40_000,
      cacheWrite: 5_000,
      total: 105_000
    },
    contextUsage: {
      tokens: 60_000,
      contextWindow: 200_000,
      percent: 30
    }
  })

  assert.deepEqual(usage, {
    totalTokens: 105_000,
    inputTokens: 50_000,
    outputTokens: 10_000,
    cachedReadTokens: 40_000,
    cachedWriteTokens: 5_000
  })
})

test('piUsageTelemetryFromPiSessionStats returns normalized display-ready details', () => {
  const usage = piUsageTelemetryFromPiSessionStats({
    tokens: {
      input: 50_000,
      output: 10_000,
      reasoning: 1_000,
      cacheRead: 40_000,
      cacheWrite: 5_000,
      total: 106_000
    },
    contextUsage: {
      tokens: 60_000,
      contextWindow: 200_000
    },
    cost: 0.42,
    currency: ' USD ',
    model: { name: 'gpt-5', provider: 'openai', effort: 'high' },
    cache: { status: 'warm' },
    autoCompaction: { enabled: true }
  })

  assert.deepEqual(usage, {
    context: { usedTokens: 60_000, maxTokens: 200_000 },
    totals: {
      totalTokens: 106_000,
      inputTokens: 50_000,
      outputTokens: 10_000,
      reasoningTokens: 1_000,
      cachedReadTokens: 40_000,
      cachedWriteTokens: 5_000
    },
    lastRequest: {
      totalTokens: 106_000,
      inputTokens: 50_000,
      outputTokens: 10_000,
      reasoningTokens: 1_000,
      cachedReadTokens: 40_000,
      cachedWriteTokens: 5_000
    },
    cost: { amount: 0.42, currency: 'USD' },
    model: { name: 'gpt-5', provider: 'openai', effort: 'high' },
    cache: { status: 'warm' },
    autoCompaction: { enabled: true }
  })
})

test('piUsageTelemetryFromPiSessionStats tolerates malformed partial stats', () => {
  const usage = piUsageTelemetryFromPiSessionStats({
    contextUsage: { tokens: -1, contextWindow: 0 },
    tokens: { input: 12.5, output: 4 },
    cost: -1,
    model: { provider: ' pi ' }
  })

  assert.deepEqual(usage, {
    totals: { outputTokens: 4 },
    lastRequest: { outputTokens: 4 },
    model: { provider: 'pi' }
  })
})
