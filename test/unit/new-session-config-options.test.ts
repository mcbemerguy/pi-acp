import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
  closeAllExcept(_sessionId: string) {}
}

test('PiAcpAgent: newSession returns ACP configOptions for model and thought level only', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        getAvailableModels: async () => ({
          models: [
            { provider: 'test', id: 'model', name: 'Model' },
            { provider: 'openrouter', id: 'anthropic/claude', name: 'Claude' }
          ]
        }),
        getState: async () => ({
          thinkingLevel: 'low',
          model: { provider: 'openrouter', id: 'anthropic/claude' }
        })
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal((response as any).models, undefined)
    assert.equal((response as any).modes, undefined)
    assert.ok(Array.isArray(response.configOptions))

    const model = response.configOptions.find(option => option.id === 'model') as any
    assert.equal(model?.category, 'model')
    assert.equal(model?.currentValue, 'openrouter/anthropic/claude')
    assert.deepEqual(
      model?.options.map((option: any) => option.value),
      ['test/model', 'openrouter/anthropic/claude']
    )

    const thinking = response.configOptions.find(option => option.id === 'thinking_level') as any
    assert.equal(thinking?.category, 'thought_level')
    assert.equal(thinking?.currentValue, 'low')
    assert.deepEqual(
      thinking?.options.map((option: any) => option.value),
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})
