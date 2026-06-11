import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: FakeRoutingSession) {}
  get(_id: string) {
    return this.session
  }
  disposeAll() {}
}

class FakeRoutingSession {
  readonly proc = new FakePiRpcProcess()
  readonly fileCommands = []
  readonly prompts: Array<{ message: string; images: unknown[]; opts: unknown }> = []
  readonly continuations: Array<{ run: unknown; message: string; opts: unknown }> = []

  constructor(
    readonly sessionId: string,
    readonly cwd: string
  ) {}

  async prompt(message: string, images: unknown[] = [], opts: unknown = {}): Promise<'end_turn'> {
    this.prompts.push({ message, images, opts })
    return 'end_turn'
  }

  async continueWorkflowRun(run: unknown, message: string, opts: unknown = {}): Promise<'end_turn'> {
    this.continuations.push({ run, message, opts })
    return 'end_turn'
  }

  wasCancelRequested(): boolean {
    return false
  }
}

function writeRun(agentDir: string, run: Record<string, unknown>): string {
  const runDir = join(agentDir, 'workflow-runs', String(run.id))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify(
      {
        cwd: run.cwd,
        runDir,
        workflowId: 'wf',
        parentSessionId: 's1',
        startedAt: '2026-06-11T00:00:00.000Z',
        ...run
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(join(runDir, 'events.jsonl'), '', 'utf8')
  return runDir
}

async function withRoutingHarness<T>(
  fn: (harness: {
    agentDir: string
    cwd: string
    session: FakeRoutingSession
    agent: PiAcpAgent
    conn: FakeAgentSideConnection
  }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-agent-workflow-routing-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(agentDir, 'workflow-runs'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir

  const conn = new FakeAgentSideConnection()
  const session = new FakeRoutingSession('s1', cwd)
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  try {
    return await fn({ agentDir, cwd, session, agent, conn })
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    agent.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

test('PiAcpAgent: next prompt resumes exactly one recoverable workflow run as continuation', async () => {
  await withRoutingHarness(async ({ agentDir, cwd, session, agent }) => {
    const runDir = writeRun(agentDir, {
      id: 'run-paused',
      cwd,
      status: 'paused',
      steps: [
        {
          id: 'plan',
          type: 'agent',
          status: 'paused',
          completionMode: 'submit_tool',
          stopReason: 'awaiting_submit_work',
          childSessionPath: join(agentDir, 'workflow-runs', 'run-paused', 'sessions', 'child.jsonl')
        }
      ]
    })

    const response = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'Use staging.' }] } as any)

    assert.equal(response.stopReason, 'end_turn')
    assert.equal(session.prompts.length, 0)
    assert.equal(session.continuations.length, 1)
    assert.deepEqual(session.continuations[0]?.opts, { reason: 'ACP prompt continuation' })
    assert.equal(session.continuations[0]?.message, 'Use staging.')
    assert.equal((session.continuations[0]?.run as any).id, 'run-paused')
    assert.equal((session.continuations[0]?.run as any).runDir, runDir)
  })
})

test('PiAcpAgent: multiple recoverable workflow runs require explicit workflow resume', async () => {
  await withRoutingHarness(async ({ agentDir, cwd, session, agent, conn }) => {
    writeRun(agentDir, { id: 'run-paused', cwd, status: 'paused' })
    writeRun(agentDir, { id: 'run-interrupted', cwd, status: 'interrupted' })

    const response = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'continue' }] } as any)

    assert.equal(response.stopReason, 'end_turn')
    assert.equal(session.prompts.length, 0)
    assert.equal(session.continuations.length, 0)
    assert.match(String((conn.updates.at(-1) as any)?.update?.content?.text), /_pi\/workflows\/resume/)
  })
})

test('PiAcpAgent: terminal failed workflow runs are not next-message continuation candidates', async () => {
  await withRoutingHarness(async ({ agentDir, cwd, session, agent }) => {
    writeRun(agentDir, {
      id: 'run-failed',
      cwd,
      status: 'failed',
      endedAt: '2026-06-11T00:01:00.000Z',
      error: 'submit-ended child failed'
    })

    const response = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'normal prompt' }] } as any)

    assert.equal(response.stopReason, 'end_turn')
    assert.equal(session.continuations.length, 0)
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.message, 'normal prompt')
  })
})
