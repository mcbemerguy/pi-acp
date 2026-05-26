import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any | null) {}
  get(sessionId: string) {
    if (!this.session || sessionId !== this.session.sessionId)
      throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

test('PiAcpAgent initialize advertises pi steering extension capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal((res.agentCapabilities?._meta as any)?.piAcp?.steering, true)
  assert.equal((res.agentCapabilities?._meta as any)?.piAcp?.steeringMethod, '_pi/steer')
  assert.deepEqual((res.agentCapabilities?._meta as any)?.piAcp?.steeringModes, ['steer', 'follow_up'])
})

test('PiAcpAgent _pi/steer sends pi RPC steer with prompt conversion parity', async () => {
  const proc = new FakePiRpcProcess() as any
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.extMethod('_pi/steer', {
    sessionId: 's1',
    mode: 'steer',
    prompt: [
      { type: 'text', text: 'Look at this' },
      { type: 'resource_link', uri: 'file:///tmp/a.ts' },
      { type: 'image', mimeType: 'image/png', data: 'aW1n' }
    ]
  })

  assert.deepEqual(res, { accepted: true, mode: 'steer' })
  assert.equal(proc.steers.length, 1)
  assert.equal(proc.steers[0].message, 'Look at this\n[Context] file:///tmp/a.ts')
  assert.deepEqual(proc.steers[0].attachments, [{ type: 'image', mimeType: 'image/png', data: 'aW1n' }])
})

test('PiAcpAgent _pi/steer follow_up mode sends pi RPC follow_up', async () => {
  const proc = new FakePiRpcProcess() as any
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.extMethod('_pi/steer', {
    sessionId: 's1',
    mode: 'follow_up',
    prompt: [{ type: 'text', text: 'next' }]
  })

  assert.deepEqual(res, { accepted: true, mode: 'follow_up' })
  assert.deepEqual(proc.followUps, [{ message: 'next', attachments: [] }])
})

test('PiAcpAgent _pi/steer rejects unknown session as protocol error', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions(null) as any

  await assert.rejects(
    () =>
      agent.extMethod('_pi/steer', {
        sessionId: 'missing',
        mode: 'steer',
        prompt: [{ type: 'text', text: 'hello' }]
      }),
    (err: unknown) => err instanceof RequestError && err.code === -32602
  )
})

test('PiAcpAgent generic session/prompt remains normal prompt path', async () => {
  const proc = new FakePiRpcProcess() as any
  const session = {
    sessionId: 's1',
    proc,
    prompt: async (message: string, images: unknown[]) => {
      await proc.prompt(message, images)
      return 'end_turn'
    },
    wasCancelRequested: () => false,
    publishUsageUpdateFromStats: () => {},
    publishPiUsageTelemetryFromStats: () => {}
  }
  proc.getSessionStats = async () => undefined
  proc.getState = async () => undefined

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'normal' }] } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: 'normal', attachments: [] }])
  assert.equal(proc.steers.length, 0)
  assert.equal(proc.followUps.length, 0)
})
