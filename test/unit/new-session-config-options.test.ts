import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const realSetTimeout = globalThis.setTimeout
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-configoptions-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir
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
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
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
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})
