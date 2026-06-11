import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function makeSession(cwd: string) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    cancelDrainTimeoutMs: 1
  })
  return { conn, proc, session }
}

test('PiAcpSession: workflow continuation participates in turn queue and session/cancel settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-continuation-'))
  const { proc, session } = makeSession(root)
  let workflowControlStarted = false
  proc.workflowControl = async (action, target, opts = {}) => {
    proc.workflowControls.push({ action, target, opts })
    workflowControlStarted = true
    return new Promise(() => undefined)
  }

  try {
    const continuation = session.continueWorkflowRun({ id: 'run-1', runDir: root }, 'continue workflow')
    while (!workflowControlStarted) await wait(1)

    const queued = session.prompt('next prompt')
    await wait(5)
    assert.equal(proc.prompts.length, 0)

    assert.deepEqual(proc.workflowControls, [
      {
        action: 'resume',
        target: root,
        opts: { continuationMessage: 'continue workflow' }
      }
    ])

    await session.cancel()
    assert.equal(proc.abortCount, 1)
    assert.equal(await continuation, 'cancelled')
    assert.equal(await queued, 'cancelled')
    assert.equal(proc.prompts.length, 0)
  } finally {
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
