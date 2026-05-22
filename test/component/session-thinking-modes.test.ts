import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

class FakeSessions {
  constructor(private readonly session: any) {}
  get(sessionId: string) {
    assert.equal(sessionId, this.session.sessionId)
    return this.session
  }
}

test('PiAcpAgent: setSessionConfigOption maps thinking level and returns refreshed configOptions', async () => {
  const conn = new FakeConn()
  const agent = new PiAcpAgent(conn as any)

  let thinkingLevel = 'medium'
  const session = {
    sessionId: 's1',
    proc: {
      getState: async () => ({ thinkingLevel, model: { provider: 'test', id: 'model' } }),
      getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'model' }] }),
      setThinkingLevel: async (value: string) => {
        thinkingLevel = value
      }
    }
  }

  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thinking_level',
    value: 'high'
  } as any)

  const thinking = result.configOptions.find(option => option.id === 'thinking_level') as any
  assert.equal(thinking?.category, 'thought_level')
  assert.equal(thinking?.currentValue, 'high')
  assert.deepEqual(
    thinking?.options.map((option: any) => option.value),
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
  )
  assert.deepEqual(conn.updates, [])
})

test('PiAcpAgent: setSessionConfigOption maps model value by splitting on first slash', async () => {
  const agent = new PiAcpAgent(new FakeConn() as any)
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  let current = { provider: 'openrouter', id: 'anthropic/claude-3.7-sonnet' }

  const session = {
    sessionId: 's1',
    proc: {
      getState: async () => ({ thinkingLevel: 'medium', model: current }),
      getAvailableModels: async () => ({
        models: [
          { provider: 'openrouter', id: 'anthropic/claude-3.7-sonnet', name: 'Claude' },
          { provider: 'openrouter', id: 'google/gemini-2.5-pro', name: 'Gemini' }
        ]
      }),
      setModel: async (provider: string, modelId: string) => {
        setModelCalls.push({ provider, modelId })
        current = { provider, id: modelId }
      }
    }
  }

  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'openrouter/google/gemini-2.5-pro'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'openrouter', modelId: 'google/gemini-2.5-pro' }])
  const model = result.configOptions.find(option => option.id === 'model') as any
  assert.equal(model?.category, 'model')
  assert.equal(model?.currentValue, 'openrouter/google/gemini-2.5-pro')
})

test('PiAcpAgent: setSessionConfigOption rejects unknown config ids and invalid thinking values', async () => {
  const agent = new PiAcpAgent(new FakeConn() as any)
  const session = {
    sessionId: 's1',
    proc: {
      getState: async () => ({ thinkingLevel: 'medium' }),
      getAvailableModels: async () => ({ models: [] })
    }
  }

  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'unknown-model' } as any),
    /invalid params/i
  )
  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'thinking_level', value: 'extreme' } as any),
    /invalid params/i
  )
  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: 's1', configId: 'unknown', value: 'high' } as any),
    /invalid params/i
  )
})
