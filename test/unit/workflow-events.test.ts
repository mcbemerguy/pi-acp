import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import {
  WorkflowEventMapper,
  WorkflowEventMonitor,
  isWorkflowCommandPrompt,
  parseWorkflowCommandPrompt
} from '../../src/acp/workflow-events.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for workflow monitor condition')
    await wait(5)
  }
}

test('isWorkflowCommandPrompt recognizes detached workflow slash commands', () => {
  assert.equal(isWorkflowCommandPrompt('/workflow:review do it'), true)
  assert.equal(isWorkflowCommandPrompt('  /workflow:review'), true)
  assert.equal(isWorkflowCommandPrompt('/workflows:review'), false)
  assert.equal(isWorkflowCommandPrompt('hello /workflow:review'), false)
  assert.deepEqual(parseWorkflowCommandPrompt('/workflow:review -- do it'), {
    workflowId: 'review',
    commandName: 'workflow:review',
    initialTaskMessage: 'do it'
  })
  assert.deepEqual(parseWorkflowCommandPrompt('/workflow:review do it'), {
    workflowId: 'review',
    commandName: 'workflow:review',
    initialTaskMessage: 'do it'
  })
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

test('WorkflowEventMapper maps workflow context usage records to ACP usage updates and telemetry', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const mapped = mapper.mapRecord({
    type: 'context_usage_update',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child-session',
    childSessionPath: '/runs/r1/sessions/child.jsonl',
    parentSessionId: 'parent-session',
    usage: {
      context: { usedTokens: 12_345, maxTokens: 200_000 },
      lastRequest: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      cost: { amount: 0.01, currency: 'USD' },
      model: { name: 'gpt-test', provider: 'openai' }
    }
  })

  assert.equal(mapped.updates.length, 1)
  assert.equal(mapped.updates[0]!.sessionUpdate, 'usage_update')
  assert.equal((mapped.updates[0] as any).used, 12_345)
  assert.equal((mapped.updates[0] as any).size, 200_000)
  assert.equal((mapped.updates[0] as any)._meta?.piWorkflow?.childSessionId, 'child-session')
  assert.equal((mapped.updates[0] as any)._meta?.piWorkflow?.stepId, 'code')
  assert.equal(mapped.usageTelemetry?.sessionId, 'parent-session')
  assert.equal(mapped.usageTelemetry?.contextSessionId, 'child-session')
  assert.equal(mapped.usageTelemetry?.workflow.stepId, 'code')
  assert.equal(mapped.usageTelemetry?.workflow.childSessionPath, '/runs/r1/sessions/child.jsonl')
  assert.deepEqual(mapped.usageTelemetry?.usage.context, { usedTokens: 12_345, maxTokens: 200_000 })
})

test('WorkflowEventMapper emits custom context telemetry even when max context size is unavailable', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const mapped = mapper.mapRecord({
    type: 'context_usage_update',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child-session',
    usage: { context: { usedTokens: 12_345 }, model: { name: 'gpt-test' } }
  })

  assert.equal(mapped.updates.length, 0)
  assert.deepEqual(mapped.usageTelemetry?.usage.context, { usedTokens: 12_345 })
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

test('WorkflowEventMapper maps subworkflow tool calls to live plan entries', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = [
    ...mapper.map({
      type: 'step_start',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'orchestrate',
      stepType: 'agent',
      status: 'running'
    }),
    ...mapper.map({
      type: 'subworkflow_call_start',
      timestamp: 't2',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'orchestrate',
      toolName: 'code_review_fix',
      childWorkflowId: 'code-review-fix',
      startedAt: '2026-05-25T18:22:13.747Z',
      task: 'Implement phase 1 with enough detail to be useful in the sidebar',
      status: 'running'
    }),
    ...mapper.map({
      type: 'subworkflow_call_end',
      timestamp: 't3',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'orchestrate',
      toolName: 'code_review_fix',
      childWorkflowId: 'code-review-fix',
      startedAt: '2026-05-25T18:22:13.747Z',
      childRunId: 'code-review-fix-1',
      status: 'completed'
    })
  ]

  const plans = updates.filter(update => update.sessionUpdate === 'plan') as any[]
  const startedEntries = plans.at(-2).entries
  const completedEntries = plans.at(-1).entries
  assert.deepEqual(
    startedEntries.map((entry: any) => entry.status),
    ['in_progress', 'in_progress']
  )
  assert.match(startedEntries[1].content, /^Subworkflow: code-review-fix via code_review_fix — Implement phase 1/)
  assert.equal(completedEntries[1].content, startedEntries[1].content)
  assert.equal(completedEntries[1].status, 'completed')
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

test('WorkflowEventMapper suppresses re-observed source identities without collapsing distinct source positions', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const record = {
    type: 'child_pi_event',
    timestamp: 'same-ms',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'tool_execution_update',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'same' }] }
    }
  }

  const first = mapper.map(record, { sourceKey: 'events:1', startOffset: 0, endOffset: 100 })
  const reread = mapper.map(record, { sourceKey: 'events:1', startOffset: 0, endOffset: 100 })
  const nextPosition = mapper.map(record, { sourceKey: 'events:1', startOffset: 101, endOffset: 201 })

  assert.equal(
    first.some(update => update.sessionUpdate === 'tool_call_update'),
    true
  )
  assert.equal(reread.length, 0)
  assert.equal(nextPosition.filter(update => update.sessionUpdate === 'tool_call_update').length, 1)
})

test('WorkflowEventMapper bounds fallback identity retention for long streams', () => {
  const mapper = new WorkflowEventMapper('/repo')
  let toolUpdates = 0

  for (let index = 0; index < 4_500; index += 1) {
    const updates = mapper.map({
      type: 'child_pi_event',
      sequence: index,
      timestamp: `t${index}`,
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      childSessionId: 'child',
      childEventType: 'tool_execution_update',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: `chunk-${index}` }] }
      }
    })
    toolUpdates += updates.filter(update => update.sessionUpdate === 'tool_call_update').length
  }

  assert.equal(toolUpdates, 4_500)
  assert.equal((mapper as any).fallbackIdentities.size, 4_096)
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

test('WorkflowEventMapper fallback identities preserve valid plan content changes', () => {
  const mapper = new WorkflowEventMapper('/repo')

  const stepStart = mapper.map({
    type: 'step_update',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    stepType: 'agent',
    status: 'running'
  })
  const stepTypeChange = mapper.map({
    type: 'step_update',
    timestamp: 't2',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    stepType: 'command',
    status: 'running'
  })
  const subworkflowStart = mapper.map({
    type: 'subworkflow_call_start',
    timestamp: 't3',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'review',
    toolName: 'workflow:review-fix',
    childWorkflowId: 'review-fix',
    startedAt: 'start-1',
    status: 'running',
    task: 'first task'
  })
  const subworkflowTaskChange = mapper.map({
    type: 'subworkflow_call_start',
    timestamp: 't4',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'review',
    toolName: 'workflow:review-fix',
    childWorkflowId: 'review-fix',
    startedAt: 'start-1',
    status: 'running',
    task: 'changed task'
  })
  const duplicateTask = mapper.map({
    type: 'subworkflow_call_start',
    timestamp: 't5',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'review',
    toolName: 'workflow:review-fix',
    childWorkflowId: 'review-fix',
    startedAt: 'start-1',
    status: 'running',
    task: 'changed task'
  })

  assert.equal(stepStart.at(-1)?.sessionUpdate, 'plan')
  assert.equal(((stepTypeChange.at(-1) as any).entries[0] as any).content, 'Workflow step: code (command)')
  assert.equal(subworkflowStart.at(-1)?.sessionUpdate, 'plan')
  assert.equal(
    ((subworkflowTaskChange.at(-1) as any).entries.at(-1) as any).content,
    'Subworkflow: review-fix via workflow:review-fix — changed task'
  )
  assert.equal(duplicateTask.length, 0)
})

test('WorkflowEventMapper fallback hashes are stable across object key order', () => {
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
      partialResult: { alpha: 1, beta: { zeta: 2, gamma: 3 } }
    }
  })
  const reordered = mapper.map({
    ...base,
    event: {
      toolName: 'bash',
      toolCallId: 'tool-1',
      type: 'tool_execution_update',
      partialResult: { beta: { gamma: 3, zeta: 2 }, alpha: 1 }
    }
  })

  assert.equal(
    first.some(update => update.sessionUpdate === 'tool_call_update'),
    true
  )
  assert.equal(reordered.length, 0)
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

test('WorkflowEventMapper includes structured diffs for nested edit tool completion', () => {
  const root = join(tmpdir(), `pi-acp-workflow-edit-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  const filePath = join(root, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')
  const mapper = new WorkflowEventMapper(root)

  mapper.map({
    type: 'child_pi_event',
    timestamp: 't1',
    runId: 'r1',
    workflowId: 'wf',
    stepId: 'code',
    childSessionId: 'child',
    childEventType: 'tool_execution_start',
    event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'edit', args: { path: 'a.txt' } }
  })
  writeFileSync(filePath, 'after\n', 'utf8')
  const updates = mapper.map({
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
      toolName: 'edit',
      isError: false,
      result: { content: [{ type: 'text', text: 'edited' }] }
    }
  })

  const toolUpdate = updates.find(update => update.sessionUpdate === 'tool_call_update') as any
  assert.equal(toolUpdate.content[0].type, 'diff')
  assert.equal(toolUpdate.content[0].path, 'a.txt')
  assert.equal(toolUpdate.content[0].oldText, 'before\n')
  assert.equal(toolUpdate.content[0].newText, 'after\n')
  assert.equal(toolUpdate.content[1].content.text, 'edited')
  rmSync(root, { recursive: true, force: true })
})

test('WorkflowEventMonitor attaches to a known active run and replays before tailing live events', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-attach-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'known')
  mkdirSync(runDir, { recursive: true })
  const eventsPath = join(runDir, 'events.jsonl')
  writeFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_start', sequence: 1, timestamp: 't1', runId: 'known', workflowId: 'wf', cwd: '/repo', status: 'running' })}\n${JSON.stringify({ type: 'step_start', sequence: 2, timestamp: 't2', runId: 'known', workflowId: 'wf', stepId: 'code', stepType: 'agent', status: 'running' })}\n`,
    'utf8'
  )
  const updates: any[] = []
  const observed: string[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    attach: { runId: 'known', runDir, sinceSequence: 0 },
    onRecord: record => observed.push(String(record.type))
  })

  try {
    monitor.start()
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'plan'))
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', sequence: 3, timestamp: 't3', runId: 'known', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )
    await monitor.waitForRunEndAfterPromptResolution()

    assert.deepEqual(observed, ['run_start', 'step_start', 'run_end'])
    assert.deepEqual(
      updates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
      ['workflow:known']
    )
    assert.ok(
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:known')
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor replays only records after the known workflow sequence', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-sequence-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'known-sequence')
  mkdirSync(runDir, { recursive: true })
  const eventsPath = join(runDir, 'events.jsonl')
  writeFileSync(
    eventsPath,
    [
      { type: 'run_start', sequence: 1, timestamp: 't1', runId: 'known-sequence', workflowId: 'wf', status: 'running' },
      {
        type: 'child_pi_event',
        sequence: 2,
        timestamp: 't2',
        runId: 'known-sequence',
        workflowId: 'wf',
        stepId: 'code',
        childSessionId: 'child',
        childEventType: 'message_update',
        event: {
          type: 'message_update',
          messageId: 'old',
          assistantMessageEvent: { type: 'text_delta', delta: 'old', partial: { id: 'old' } }
        }
      },
      {
        type: 'child_pi_event',
        sequence: 3,
        timestamp: 't3',
        runId: 'known-sequence',
        workflowId: 'wf',
        stepId: 'code',
        childSessionId: 'child',
        childEventType: 'message_update',
        event: {
          type: 'message_update',
          messageId: 'new',
          assistantMessageEvent: { type: 'text_delta', delta: 'new', partial: { id: 'new' } }
        }
      }
    ]
      .map(record => JSON.stringify(record))
      .join('\n') + '\n',
    'utf8'
  )
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    attach: { runId: 'known-sequence', runDir, sinceSequence: 2 }
  })

  try {
    monitor.start()
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'agent_message_chunk'))
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', sequence: 4, timestamp: 't4', runId: 'known-sequence', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )
    await monitor.waitForRunEndAfterPromptResolution()

    assert.deepEqual(
      updates
        .filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        .map(update => update.content.text),
      ['new', 'Workflow wf completed.']
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor attached replay buffers an unterminated final record until newline arrives', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-attach-partial-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'partial')
  mkdirSync(runDir, { recursive: true })
  const eventsPath = join(runDir, 'events.jsonl')
  writeFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_start', sequence: 1, timestamp: 't1', runId: 'partial', workflowId: 'wf', cwd: '/repo', status: 'running' })}\n` +
      '{"type":"step_start","sequence":2,"timestamp":"t2","runId":"partial","workflowId":"wf","stepId":"code","title":"Code"',
    'utf8'
  )
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    attach: { runId: 'partial', runDir, sinceSequence: 0 }
  })

  try {
    monitor.start()
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'tool_call'))
    appendFileSync(eventsPath, ',"status":"running"}\n', 'utf8')
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'plan'))
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', sequence: 3, timestamp: 't3', runId: 'partial', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )
    await monitor.waitForRunEndAfterPromptResolution()

    assert.equal(monitor.getIngestionSnapshot().malformedLines, 0)
    assert.ok(updates.some(update => update.sessionUpdate === 'plan'))
    assert.ok(
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:partial')
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor attached replay emits terminal run.json fallback when run_end is missing', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-attach-terminal-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'terminal')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_start', sequence: 1, timestamp: 't1', runId: 'terminal', workflowId: 'wf', cwd: '/repo', status: 'running' })}\n`,
    'utf8'
  )
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'terminal',
      workflowId: 'wf',
      cwd: '/repo',
      runDir,
      status: 'completed',
      endedAt: '2026-05-30T00:00:00.000Z'
    }),
    'utf8'
  )
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    attach: { runId: 'terminal', runDir, sinceSequence: 0 }
  })

  try {
    monitor.start()
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'tool_call_update'))
    const finalUpdate = updates.find(
      update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:terminal'
    )
    assert.equal(finalUpdate?.status, 'completed')
    assert.equal(finalUpdate?.rawOutput?.status, 'completed')
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor tails explicitly linked subworkflow run artifacts', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-linked-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const parentRunDir = join(workflowRunsDir, 'parent')
  const childRunDir = join(workflowRunsDir, 'child')
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20
  })

  try {
    monitor.start()
    mkdirSync(parentRunDir, { recursive: true })
    mkdirSync(childRunDir, { recursive: true })
    writeFileSync(
      join(parentRunDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'parent', workflowId: 'root', cwd: '/repo' })}\n${JSON.stringify({ type: 'subworkflow_call_start', timestamp: 't2', runId: 'parent', workflowId: 'root', stepId: 'orchestrate', toolName: 'code_review_fix', childWorkflowId: 'code-review-fix', startedAt: 'started', childRunId: 'child', childRunDir, status: 'running' })}\n`,
      'utf8'
    )
    writeFileSync(
      join(childRunDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: 't3', runId: 'child', workflowId: 'code-review-fix', cwd: '/repo' })}\n${JSON.stringify({ type: 'run_end', timestamp: 't4', runId: 'child', workflowId: 'code-review-fix', status: 'completed' })}\n`,
      'utf8'
    )

    await waitUntil(() =>
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:child')
    )
    appendFileSync(
      join(parentRunDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_end', timestamp: 't5', runId: 'parent', workflowId: 'root', status: 'completed' })}\n`,
      'utf8'
    )
    await monitor.waitForRunEndAfterPromptResolution()

    assert.ok(updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'workflow:child'))
    assert.ok(
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:child')
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
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

test('WorkflowEventMonitor suppresses source-position duplicates when a tail is re-read', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-reread-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'reread')
  const eventsPath = join(runDir, 'events.jsonl')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20
  })

  try {
    monitor.start()
    mkdirSync(runDir)
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'reread', workflowId: 'wf', status: 'running' })}\n${JSON.stringify({ type: 'child_pi_event', timestamp: 't2', runId: 'reread', workflowId: 'wf', stepId: 'code', childSessionId: 'child', childEventType: 'message_update', event: { type: 'message_update', messageId: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'hello', partial: { id: 'm1' } } } })}\n`,
      'utf8'
    )
    await waitUntil(() => updates.some(update => update.sessionUpdate === 'agent_message_chunk'))

    const tail = Array.from((monitor as any).tails.values())[0] as any
    tail.offset = 0
    tail.buffer = ''
    tail.bufferStartOffset = 0
    tail.decoder = new StringDecoder('utf8')

    await waitUntil(() => monitor.getIngestionSnapshot().recordsObserved >= 4)
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', timestamp: 't3', runId: 'reread', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )
    await monitor.waitForRunEndAfterPromptResolution()

    assert.equal(updates.filter(update => update.sessionUpdate === 'tool_call').length, 1)
    assert.deepEqual(
      updates
        .filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
        .map(update => update.content.text),
      ['hello', 'Workflow wf completed.']
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor tails large JSONL lines incrementally once and in order', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-large-tail-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'large')
  const eventsPath = join(runDir, 'events.jsonl')
  const observedSequences: number[] = []
  const monitor = new WorkflowEventMonitor('/repo', () => {}, {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    onRecord: record => observedSequences.push(Number(record.sequence))
  })

  const payload = 'x'.repeat(8_000)
  const records: Record<string, unknown>[] = [
    { type: 'run_start', sequence: 0, timestamp: 't0', runId: 'large', workflowId: 'wf', status: 'running' },
    ...Array.from({ length: 10 }, (_, index) => ({
      type: 'child_pi_event',
      sequence: index + 1,
      timestamp: `t${index + 1}`,
      runId: 'large',
      workflowId: 'wf',
      stepId: 'code',
      childSessionId: 'child',
      childEventType: 'message_update',
      event: {
        type: 'message_update',
        messageId: `m-${index}`,
        assistantMessageEvent: { type: 'text_delta', delta: `${index}-${payload}`, partial: { id: `m-${index}` } }
      }
    })),
    { type: 'run_end', sequence: 11, timestamp: 't11', runId: 'large', workflowId: 'wf', status: 'completed' }
  ]

  let bytesWritten = 0
  try {
    monitor.start()
    mkdirSync(runDir, { recursive: true })
    writeFileSync(eventsPath, '', 'utf8')
    for (const [index, record] of records.entries()) {
      const line = `${JSON.stringify(record)}\n`
      appendFileSync(eventsPath, line, 'utf8')
      bytesWritten += Buffer.byteLength(line)
      await waitUntil(() => observedSequences.length === index + 1)
    }
    await monitor.waitForRunEndAfterPromptResolution()

    assert.deepEqual(
      observedSequences,
      records.map(record => Number(record.sequence))
    )
    const snapshot = monitor.getIngestionSnapshot()
    assert.equal(snapshot.recordsObserved, records.length)
    assert.equal(snapshot.newBytesObserved, bytesWritten)
    assert.equal(snapshot.fileBytesRead, bytesWritten)
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor observes fast runs that complete before the next poll', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-fast-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 25,
    graceMs: 20
  })

  try {
    monitor.start()
    const runDir = join(workflowRunsDir, 'fast')
    mkdirSync(runDir)
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'fast', workflowId: 'wf', status: 'running' })}\n${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'fast', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )

    await monitor.waitForRunEndAfterPromptResolution()
    assert.deepEqual(
      updates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
      ['workflow:fast']
    )
    assert.ok(
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:fast')
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor handles events.jsonl truncation while preserving terminal observation', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-truncate-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20
  })

  try {
    monitor.start()
    const runDir = join(workflowRunsDir, 'truncated')
    mkdirSync(runDir)
    const eventsPath = join(runDir, 'events.jsonl')
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'truncated', workflowId: 'wf', status: 'running', padding: 'x'.repeat(2_000) })}\n`,
      'utf8'
    )
    await waitUntil(() =>
      updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'workflow:truncated')
    )

    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'truncated', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )

    await monitor.waitForRunEndAfterPromptResolution()
    assert.ok(
      updates.some(
        update =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'workflow:truncated' &&
          update.status === 'completed'
      )
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor handles events.jsonl rotation while preserving terminal observation', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-rotate-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20
  })

  try {
    monitor.start()
    const runDir = join(workflowRunsDir, 'rotated')
    mkdirSync(runDir)
    const eventsPath = join(runDir, 'events.jsonl')
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'rotated', workflowId: 'wf', status: 'running' })}\n`,
      'utf8'
    )
    await waitUntil(() =>
      updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'workflow:rotated')
    )

    renameSync(eventsPath, join(runDir, 'events.jsonl.1'))
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'rotated', workflowId: 'wf', status: 'completed' })}\n`,
      'utf8'
    )

    await monitor.waitForRunEndAfterPromptResolution()
    assert.ok(
      updates.some(
        update =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'workflow:rotated' &&
          update.status === 'completed'
      )
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor can discover targeted runs from events.jsonl when run.json is missing', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-no-run-json-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    target: { workflowId: 'review', commandName: 'workflow:review', initialTaskMessage: 'task', parentSessionId: 's1' }
  })

  try {
    monitor.start()
    const runDir = join(workflowRunsDir, 'events-only')
    mkdirSync(runDir)
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'events-only', workflowId: 'review', rootWorkflowId: 'review', commandName: 'workflow:review', cwd: '/repo', initialTaskMessage: 'task', parentSessionId: 's1', status: 'running' })}\n${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'events-only', workflowId: 'review', rootWorkflowId: 'review', commandName: 'workflow:review', cwd: '/repo', status: 'completed' })}\n`,
      'utf8'
    )

    await monitor.waitForRunEndAfterPromptResolution()
    assert.deepEqual(
      updates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
      ['workflow:events-only']
    )
    assert.ok(
      updates.some(
        update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:events-only'
      )
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor can keep tailing an accepted run until run_end', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-wait-${process.pid}-${Date.now()}`)
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
  writeFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf', status: 'running' })}\n`,
    'utf8'
  )

  let stopped = false
  const stop = monitor.waitForRunEndAfterPromptResolution().then(() => {
    stopped = true
  })

  await wait(80)
  assert.equal(stopped, false)
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'r1', workflowId: 'wf', status: 'completed' })}\n`
  )
  await stop

  assert.equal(stopped, true)
  assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'))
  rmSync(root, { recursive: true, force: true })
})

test('WorkflowEventMonitor keeps tailing briefly after terminal run.json so real run_end is not lost', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-run-json-race-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const observedTypes: string[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 80,
    onRecord: record => observedTypes.push(String(record.type))
  })

  try {
    monitor.start()
    const runDir = join(workflowRunsDir, 'r1')
    mkdirSync(runDir)
    const eventsPath = join(runDir, 'events.jsonl')
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf', status: 'running' })}\n`,
      'utf8'
    )
    await waitUntil(() => observedTypes.includes('run_start'))

    const stop = monitor.waitForRunEndAfterPromptResolution()
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        id: 'r1',
        workflowId: 'wf',
        cwd: '/repo',
        runDir,
        status: 'completed',
        endedAt: '2026-05-26T00:00:00.000Z'
      }),
      'utf8'
    )

    await wait(25)
    assert.equal(
      updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'),
      false
    )

    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type: 'run_end', timestamp: 't2', runId: 'r1', workflowId: 'wf', status: 'completed' })}\n`
    )
    await stop

    assert.deepEqual(observedTypes, ['run_start', 'run_end'])
    const finalUpdate = updates.find(
      update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'
    )
    assert.equal(finalUpdate?.status, 'completed')
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkflowEventMonitor falls back to terminal run.json when run_end is missing', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-run-json-${process.pid}-${Date.now()}`)
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
  writeFileSync(
    eventsPath,
    `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf', status: 'running' })}\n`,
    'utf8'
  )

  const stop = monitor.waitForRunEndAfterPromptResolution()
  await wait(30)
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'r1',
      workflowId: 'wf',
      cwd: '/repo',
      runDir,
      auditPath: join(runDir, 'audit.md'),
      status: 'completed',
      endedAt: '2026-05-26T00:00:00.000Z'
    }),
    'utf8'
  )

  await stop
  const finalUpdate = updates.find(
    update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'
  )
  assert.equal(finalUpdate?.status, 'completed')
  rmSync(root, { recursive: true, force: true })
})

test('WorkflowEventMonitor times out accepted runs that never publish a terminal state', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-timeout-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 10,
    graceMs: 30,
    runEndMaxWaitMs: 35
  })

  monitor.start()
  const runDir = join(workflowRunsDir, 'r1')
  mkdirSync(runDir)
  writeFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_start', timestamp: 't1', runId: 'r1', workflowId: 'wf', status: 'running' })}\n`,
    'utf8'
  )

  await monitor.waitForRunEndAfterPromptResolution()

  const finalUpdate = updates.find(
    update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:r1'
  )
  assert.equal(finalUpdate?.status, 'failed')
  assert.match(JSON.stringify(finalUpdate?.rawOutput), /run_end was not observed/)
  rmSync(root, { recursive: true, force: true })
})

test('WorkflowEventMonitor filters workflow runs by cwd, workflow id, task, and locks to the accepted run', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-filter-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 10,
    graceMs: 30,
    target: { workflowId: 'plan-discussion', initialTaskMessage: 'task', parentSessionId: 'session-1' }
  })

  monitor.start()

  const writeRun = (id: string, run: Record<string, unknown>) => {
    const runDir = join(workflowRunsDir, id)
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(run), 'utf8')
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'run_start', timestamp: `t-${id}`, runId: id, workflowId: run.workflowId, rootWorkflowId: run.workflowId, cwd: run.cwd, status: 'running' })}\n`,
      'utf8'
    )
  }

  writeRun('wrong-cwd', {
    id: 'wrong-cwd',
    workflowId: 'plan-discussion',
    cwd: '/other',
    initialTaskMessage: 'task',
    parentSessionId: 'session-1'
  })
  writeRun('wrong-workflow', {
    id: 'wrong-workflow',
    workflowId: 'code-review-fix',
    cwd: '/repo',
    initialTaskMessage: 'task',
    parentSessionId: 'session-1'
  })
  writeRun('missing-parent-session', {
    id: 'missing-parent-session',
    workflowId: 'plan-discussion',
    cwd: '/repo',
    initialTaskMessage: 'task'
  })
  writeRun('accepted', {
    id: 'accepted',
    workflowId: 'plan-discussion',
    cwd: '/repo',
    initialTaskMessage: 'task',
    parentSessionId: 'session-1'
  })

  await wait(40)

  writeRun('also-matching-but-late', {
    id: 'also-matching-but-late',
    workflowId: 'plan-discussion',
    cwd: '/repo',
    initialTaskMessage: 'task',
    parentSessionId: 'session-1'
  })
  appendFileSync(
    join(workflowRunsDir, 'accepted', 'events.jsonl'),
    `${JSON.stringify({ type: 'run_end', timestamp: 't-end', runId: 'accepted', workflowId: 'plan-discussion', rootWorkflowId: 'plan-discussion', cwd: '/repo', status: 'completed' })}\n`
  )

  await monitor.stopAfterPromptResolution()
  const workflowToolIds = updates
    .filter(update => update.sessionUpdate === 'tool_call')
    .map(update => update.toolCallId)
  assert.deepEqual(workflowToolIds, ['workflow:accepted'])
  assert.ok(
    updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:accepted')
  )
  rmSync(root, { recursive: true, force: true })
})

test('WorkflowEventMonitor matches custom workflow command names against Pi run metadata', async () => {
  const root = join(tmpdir(), `pi-acp-workflow-command-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  mkdirSync(workflowRunsDir, { recursive: true })
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 10,
    graceMs: 30,
    target: {
      workflowId: 'review',
      commandName: 'workflow:review',
      initialTaskMessage: 'task',
      parentSessionId: 'session-1'
    }
  })

  monitor.start()
  const runDir = join(workflowRunsDir, 'custom')
  mkdirSync(runDir)
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: 'custom',
      workflowId: 'code-review-fix',
      commandName: 'workflow:review',
      cwd: '/repo',
      initialTaskMessage: 'task',
      parentSessionId: 'session-1'
    }),
    'utf8'
  )
  writeFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_start', timestamp: 't-custom', runId: 'custom', workflowId: 'code-review-fix', rootWorkflowId: 'code-review-fix', commandName: 'workflow:review', cwd: '/repo', status: 'running' })}\n`,
    'utf8'
  )

  await wait(40)
  appendFileSync(
    join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'run_end', timestamp: 't-end', runId: 'custom', workflowId: 'code-review-fix', rootWorkflowId: 'code-review-fix', commandName: 'workflow:review', cwd: '/repo', status: 'completed' })}\n`
  )

  await monitor.stopAfterPromptResolution()
  assert.deepEqual(
    updates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId),
    ['workflow:custom']
  )
  assert.ok(
    updates.some(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'workflow:custom')
  )
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
  assert.equal(summary.content.text, `Workflow wf failed. Audit: [audit.md](<${auditUri}>)`)
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

test('WorkflowEventMapper truncates large child tool result presentation and keeps workflow source metadata', () => {
  const mapper = new WorkflowEventMapper('/repo')
  const updates = mapper.map(
    {
      type: 'child_pi_event',
      timestamp: 't1',
      runId: 'r1',
      workflowId: 'wf',
      stepId: 'code',
      childSessionId: 'child',
      childEventType: 'tool_execution_end',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        isError: false,
        result: { details: { stdout: 'x'.repeat(140 * 1024) } }
      }
    },
    { sourceKey: 'events-jsonl:/runs/r1/events.jsonl', startOffset: 10, endOffset: 20 }
  ) as any[]

  const update = updates.find(item => item.sessionUpdate === 'tool_call_update')
  assert.ok(update)
  assert.match(update.content[0].content.text, /presentation truncated/)
  assert.equal(update.rawOutput.piAcpPresentation.truncated, true)
  assert.equal(update._meta.piWorkflow.source.startOffset, 10)
})
