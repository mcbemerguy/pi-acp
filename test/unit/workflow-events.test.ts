import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkflowEventMapper, WorkflowEventMonitor, isWorkflowCommandPrompt } from '../../src/acp/workflow-events.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('isWorkflowCommandPrompt recognizes detached workflow slash commands', () => {
  assert.equal(isWorkflowCommandPrompt('/workflow:review do it'), true)
  assert.equal(isWorkflowCommandPrompt('  /workflow:review'), true)
  assert.equal(isWorkflowCommandPrompt('/workflows:review'), false)
  assert.equal(isWorkflowCommandPrompt('hello /workflow:review'), false)
})

test('WorkflowEventMapper maps workflow run and step events to ACP updates', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'run_start',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      runDir: '/runs/r1',
      auditPath: '/runs/r1/audit.md',
      status: 'running'
    }),
    ...mapper.map({
      type: 'step_start',
      timestamp: 't2',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      stepType: 'agent',
      status: 'running'
    }),
    ...mapper.map({
      type: 'step_update',
      timestamp: 't3',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      stepType: 'agent',
      status: 'running',
      activity: 'Running tests'
    }),
    ...mapper.map({
      type: 'step_end',
      timestamp: 't4',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      stepType: 'agent',
      status: 'completed'
    }),
    ...mapper.map({
      type: 'run_end',
      timestamp: 't5',
      runId: 'r1',
      workflowId: 'wf',
      auditPath: '/runs/r1/audit.md',
      status: 'completed'
    })
  ]

  assert.equal(updates[0]!.sessionUpdate, 'tool_call')
  assert.equal((updates[0] as any).toolCallId, 'workflow:r1')
  assert.equal((updates[0] as any).status, 'in_progress')

  const stepStart = updates.find(
    update => update.sessionUpdate === 'tool_call' && (update as any).toolCallId === 'workflow:r1:step:code'
  ) as any
  assert.ok(stepStart)
  assert.equal(stepStart.title, 'Workflow step: code (agent)')
  assert.equal(stepStart.status, 'in_progress')

  const stepEnd = updates.find(
    update =>
      update.sessionUpdate === 'tool_call_update' &&
      (update as any).toolCallId === 'workflow:r1:step:code' &&
      (update as any).status === 'completed'
  ) as any
  assert.ok(stepEnd)

  const plans = updates.filter(update => update.sessionUpdate === 'plan') as any[]
  assert.ok(plans.length >= 1)
  assert.equal(plans.at(-1).entries[0].status, 'completed')

  const runEnd = updates.find(
    update => update.sessionUpdate === 'tool_call_update' && (update as any).toolCallId === 'workflow:r1'
  ) as any
  assert.ok(runEnd)
  assert.equal(runEnd.status, 'completed')

  const link = updates.find(
    update => update.sessionUpdate === 'agent_message_chunk' && (update as any).content.type === 'resource_link'
  ) as any
  assert.ok(link)
  assert.equal(link.content.uri, pathToFileURL('/runs/r1/audit.md').href)
})

test('WorkflowEventMapper maps child tool events with correlated stable IDs', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'child_pi_event',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      childSessionId: 'child',
      childEventType: 'tool_execution_start',
      event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'a.txt' } }
    }),
    ...mapper.map({
      type: 'child_pi_event',
      timestamp: 't2',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      childSessionId: 'child',
      childEventType: 'tool_execution_end',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: 'done' }] }
      }
    })
  ]

  assert.equal(updates[0]!.sessionUpdate, 'tool_call')
  assert.equal((updates[0] as any).toolCallId, 'workflow:r1:step:code:tool:tool-1')
  assert.equal((updates[0] as any).kind, 'read')
  assert.deepEqual((updates[0] as any).locations, [{ path: resolve('/repo', 'a.txt') }])

  assert.equal(updates[1]!.sessionUpdate, 'tool_call_update')
  assert.equal((updates[1] as any).toolCallId, 'workflow:r1:step:code:tool:tool-1')
  assert.equal((updates[1] as any).status, 'completed')
  assert.equal((updates[1] as any).content[0].content.text, 'done')
})

test('WorkflowEventMonitor tails new run artifacts and tolerates malformed partial and duplicate lines', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 10,
    graceMs: 30
  })

  monitor.start()
  const runDir = join(workflowRunsDir, 'r1')
  mkdirSync(runDir)
  const eventsPath = join(runDir, 'events.jsonl')
  writeFileSync(eventsPath, '{bad json}\n', 'utf8')
  appendFileSync(eventsPath, JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf' }))
  await wait(25)
  assert.equal(updates.length, 0)
  appendFileSync(eventsPath, '\n')
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf' })}\n`
  )
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'r1', workflowId: 'wf', status: 'completed' })}\n`
  )

  await monitor.stopAfterPromptResolution()
  assert.equal(updates.filter(update => update.sessionUpdate === 'tool_call').length, 1)
  assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'))
  rmSync(root, { recursive: true, force: true })
})
