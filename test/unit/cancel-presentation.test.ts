import test from 'node:test'
import assert from 'node:assert/strict'
import { filterCancelReplayBacklog } from '../../src/acp/cancel-presentation.js'
import { PI_WORKFLOWS_EVENTS_METHOD } from '../../src/acp/workflows.js'

test('cancel presentation boundary drops stale text backlog and preserves semantic workflow notifications', () => {
  const staleText = {
    kind: 'sessionUpdate' as const,
    update: {
      sessionUpdate: 'agent_message_chunk' as const,
      content: { type: 'text' as const, text: 'old child text' }
    }
  }
  const workflowEvent = {
    kind: 'extNotification' as const,
    method: PI_WORKFLOWS_EVENTS_METHOD,
    params: { runId: 'run', sequence: 7, event: { type: 'run_interrupted', runId: 'run', sequence: 7 } }
  }

  const result = filterCancelReplayBacklog([staleText, workflowEvent])

  assert.deepEqual(result.kept, [workflowEvent])
  assert.deepEqual(result.dropped, [staleText])
  assert.deepEqual(result.coalesced, [])
  assert.equal(result.stats.droppedReplayBacklog, 1)
  assert.equal(result.stats.preservedSemanticBacklog, 1)
})

test('cancel presentation boundary coalesces routine replay backlog separately from dropped backlog', () => {
  const routineOne = {
    kind: 'sessionUpdate' as const,
    update: { sessionUpdate: 'session_info_update' as const, _meta: { piAcp: { running: true } } }
  }
  const routineTwo = {
    kind: 'sessionUpdate' as const,
    update: { sessionUpdate: 'session_info_update' as const, _meta: { piAcp: { running: false } } }
  }
  const staleThought = {
    kind: 'sessionUpdate' as const,
    update: { sessionUpdate: 'agent_thought_chunk' as const, content: { type: 'text' as const, text: 'old thought' } }
  }

  const result = filterCancelReplayBacklog([routineOne, staleThought, routineTwo])

  assert.deepEqual(result.kept, [routineTwo])
  assert.deepEqual(result.dropped, [staleThought])
  assert.deepEqual(result.coalesced, [routineOne])
  assert.equal(result.stats.droppedReplayBacklog, 1)
  assert.equal(result.stats.coalescedReplayBacklog, 1)
  assert.equal(result.stats.preservedRoutineBacklog, 1)
})

test('cancel presentation boundary preserves final tool lifecycle boundaries', () => {
  const toolStart = {
    kind: 'sessionUpdate' as const,
    update: {
      sessionUpdate: 'tool_call' as const,
      toolCallId: 'child-tool',
      title: 'read',
      kind: 'read' as const,
      status: 'in_progress' as const
    }
  }
  const toolEnd = {
    kind: 'sessionUpdate' as const,
    update: { sessionUpdate: 'tool_call_update' as const, toolCallId: 'child-tool', status: 'completed' as const }
  }

  const result = filterCancelReplayBacklog([toolStart, toolEnd])

  assert.deepEqual(result.kept, [toolEnd])
  assert.deepEqual(result.dropped, [toolStart])
  assert.equal(result.stats.preservedSemanticBacklog, 1)
})
