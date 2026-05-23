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

test('WorkflowEventMapper maps workflow run events and step plan updates to ACP updates', () => {
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

  assert.equal(
    updates.some(
      update =>
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        (update as any).toolCallId === 'workflow:r1:step:code'
    ),
    false
  )

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

test('WorkflowEventMapper maps inline subworkflow completion to a completed plan entry', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'inline_subworkflow_start',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'review-fix',
      childWorkflowId: 'review-fix',
      status: 'running'
    }),
    ...mapper.map({
      type: 'inline_subworkflow_end',
      timestamp: 't2',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'review-fix',
      childWorkflowId: 'review-fix',
      status: 'completed'
    })
  ]

  const plans = updates.filter(update => update.sessionUpdate === 'plan') as any[]
  assert.equal(plans.at(-1).entries[0].content, 'Workflow step: review-fix (workflow)')
  assert.equal(plans.at(-1).entries[0].status, 'completed')
})

test('WorkflowEventMapper completes open plan entries when a workflow run ends', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'step_start',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'review-fix',
      stepType: 'workflow',
      status: 'running'
    }),
    ...mapper.map({
      type: 'run_end',
      timestamp: 't2',
      runId: 'r1',
      workflowId: 'wf',
      status: 'completed'
    })
  ]

  const plans = updates.filter(update => update.sessionUpdate === 'plan') as any[]
  assert.equal(plans.at(-1).entries[0].status, 'completed')
})

test('WorkflowEventMapper only completes open plan entries for the workflow run that ended', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'step_start',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      stepType: 'agent',
      status: 'running'
    }),
    ...mapper.map({
      type: 'step_start',
      timestamp: 't2',
      runId: 'r2',
      workflowId: 'wf',
      stepId: 'review',
      stepType: 'agent',
      status: 'running'
    }),
    ...mapper.map({
      type: 'run_end',
      timestamp: 't3',
      runId: 'r1',
      workflowId: 'wf',
      status: 'completed'
    })
  ]

  const finalPlan = updates.filter(update => update.sessionUpdate === 'plan').at(-1) as any
  assert.deepEqual(
    finalPlan.entries.map((entry: any) => ({ toolCallId: entry._meta.piWorkflow.toolCallId, status: entry.status })),
    [
      { toolCallId: 'workflow:r1:step:code', status: 'completed' },
      { toolCallId: 'workflow:r2:step:review', status: 'in_progress' }
    ]
  )
})

test('WorkflowEventMapper maps distinct child tool updates that share a timestamp', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const base = {
    type: 'child_pi_event',
    timestamp: 'same-ms',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'tool_execution_update'
  }

  const first = mapper.map({
    ...base,
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'one' }] }
    }
  })
  const second = mapper.map({
    ...base,
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'two' }] }
    }
  })
  const duplicate = mapper.map({
    ...base,
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'two' }] }
    }
  })

  assert.equal(
    first.some(update => update.sessionUpdate === 'tool_call_update'),
    true
  )
  assert.equal(
    second.some(update => update.sessionUpdate === 'tool_call_update'),
    true
  )
  assert.equal(duplicate.length, 0)
})

test('WorkflowEventMapper projects child assistant text deltas and avoids duplicate message_end fallback', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const delta = mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_update',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello ' }
    }
  })
  const end = mapper.map({
    type: 'child_pi_event',
    timestamp: 't2',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_end',
    event: {
      type: 'message_end',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'hello world' }] }
    }
  })

  assert.equal(delta.length, 1)
  assert.equal(delta[0]!.sessionUpdate, 'agent_message_chunk')
  assert.match((delta[0] as any).messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal((delta[0] as any).content.text, 'hello ')
  assert.deepEqual((delta[0] as any)._meta.piWorkflow.stepId, 'code')
  assert.equal(end.length, 0)
})

test('WorkflowEventMapper emits child message_end text when no delta was seen', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_end',
    event: {
      type: 'message_end',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'final text' }] }
    }
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.sessionUpdate, 'agent_message_chunk')
  assert.match(
    (updates[0] as any).messageId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  assert.equal((updates[0] as any).content.text, 'final text')
})

test('WorkflowEventMapper only suppresses the next message_end after no-id text deltas', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const delta = mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_update',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'streamed' }
    }
  })
  const streamedEnd = mapper.map({
    type: 'child_pi_event',
    timestamp: 't2',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_end',
    event: {
      type: 'message_end',
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'streamed final' }] }
    }
  })
  const fallbackEnd = mapper.map({
    type: 'child_pi_event',
    timestamp: 't3',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_end',
    event: {
      type: 'message_end',
      message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'fallback final' }] }
    }
  })

  assert.equal(delta.length, 1)
  assert.equal(streamedEnd.length, 0)
  assert.equal(fallbackEnd.length, 1)
  assert.equal((fallbackEnd[0] as any).content.text, 'fallback final')
})

test('WorkflowEventMapper projects child thinking deltas as ACP thought chunks', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'message_update',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
    }
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.sessionUpdate, 'agent_thought_chunk')
  assert.equal((updates[0] as any).content.text, 'thinking')
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
  assert.equal((updates[1] as any).title, 'read')
  assert.equal((updates[1] as any).kind, 'read')
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

test('WorkflowEventMapper renders audit summary without raw Markdown-sensitive Windows path', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const auditPath = String.raw`C:\Users\marcos.bemerguy\.pi\agent\workflow-runs\r1\audit.md`
  const updates = mapper.map({
    type: 'run_end',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    auditPath,
    status: 'failed'
  })

  const summary = updates.find(
    update => update.sessionUpdate === 'agent_message_chunk' && (update as any).content.type === 'text'
  ) as any
  const link = updates.find(
    update => update.sessionUpdate === 'agent_message_chunk' && (update as any).content.type === 'resource_link'
  ) as any

  const auditUri = pathToFileURL(auditPath).href

  assert.ok(summary)
  assert.equal(summary.content.text, `Workflow wf failed. Audit: ${auditUri}`)
  assert.equal(summary.content.text.includes(auditPath), false)
  assert.ok(link)
  assert.equal(link.content.uri, auditUri)
})

test('WorkflowEventMapper maps child bash tools to ACP execute kind', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'tool_execution_start',
    event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { cmd: 'npm test' } }
  })

  assert.equal(updates[0]!.sessionUpdate, 'tool_call')
  assert.equal((updates[0] as any).title, 'bash')
  assert.equal((updates[0] as any).kind, 'execute')
})
