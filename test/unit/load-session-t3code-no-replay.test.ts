import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return {
      sessionId: 's1',
      cwd: process.cwd(),
      sessionFile: 'memory://s1.jsonl',
      updatedAt: new Date().toISOString()
    }
  }
  upsert() {}
}

test('PiAcpAgent: skips loadSession history replay for t3-code clients', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  let getMessagesCalls = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => {
        getMessagesCalls += 1
        return {
          messages: [
            { role: 'user', content: 'previous user' },
            { role: 'assistant', content: [{ type: 'text', text: 'previous assistant' }] }
          ]
        }
      },
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({
      protocolVersion: 1,
      clientInfo: { name: 't3-code', version: '0.0.0' },
      clientCapabilities: {}
    } as any)

    await agent.loadSession({ sessionId: 's1', cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(getMessagesCalls, 0)
    assert.equal(
      conn.updates.some(update => {
        const text = (update as any).update?.content?.text
        return text === 'previous user' || text === 'previous assistant'
      }),
      false
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})
