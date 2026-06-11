import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { PI_USAGE_UPDATE_METHOD } from './usage.js'
import { PI_WORKFLOWS_EVENTS_METHOD } from './workflows.js'

export type CancelPresentationOutboundItem = {
  kind: 'sessionUpdate' | 'extNotification'
  update?: SessionUpdate
  method?: string
  params?: Record<string, unknown>
}

export type CancelPresentationStats = {
  droppedReplayBacklog: number
  coalescedReplayBacklog: number
  preservedSemanticBacklog: number
  preservedRoutineBacklog: number
  actualSendFailures: number
  diagnostics: number
}

export type CancelPresentationFilterResult<T extends CancelPresentationOutboundItem> = {
  kept: T[]
  dropped: T[]
  coalesced: T[]
  stats: Pick<
    CancelPresentationStats,
    'droppedReplayBacklog' | 'coalescedReplayBacklog' | 'preservedSemanticBacklog' | 'preservedRoutineBacklog'
  >
}

type Classification =
  | { disposition: 'preserve'; semantic: boolean }
  | { disposition: 'drop' }
  | { disposition: 'coalesce'; key: string }

export const CANCEL_PRESENTATION_MODE = 'semantic_drain'

const SEMANTIC_WORKFLOW_EVENT_TYPES = new Set([
  'run_start',
  'run_end',
  'run_interrupted',
  'run_paused',
  'run_resume_requested'
])

export const DEFAULT_CANCEL_PRESENTATION_STATS: CancelPresentationStats = {
  droppedReplayBacklog: 0,
  coalescedReplayBacklog: 0,
  preservedSemanticBacklog: 0,
  preservedRoutineBacklog: 0,
  actualSendFailures: 0,
  diagnostics: 0
}

export function filterCancelReplayBacklog<T extends CancelPresentationOutboundItem>(
  items: readonly T[]
): CancelPresentationFilterResult<T> {
  const kept: T[] = []
  const dropped: T[] = []
  const coalesced: T[] = []
  const coalesceSlots = new Map<string, { index: number; item: T }>()
  const stats = {
    droppedReplayBacklog: 0,
    coalescedReplayBacklog: 0,
    preservedSemanticBacklog: 0,
    preservedRoutineBacklog: 0
  }

  for (const item of items) {
    const classification = classifyCancelReplayBacklogItem(item)
    if (classification.disposition === 'preserve') {
      kept.push(item)
      if (classification.semantic) stats.preservedSemanticBacklog += 1
      else stats.preservedRoutineBacklog += 1
      continue
    }

    if (classification.disposition === 'drop') {
      dropped.push(item)
      stats.droppedReplayBacklog += 1
      continue
    }

    const previous = coalesceSlots.get(classification.key)
    if (previous) {
      coalesced.push(previous.item)
      stats.coalescedReplayBacklog += 1
      kept[previous.index] = item
      coalesceSlots.set(classification.key, { index: previous.index, item })
    } else {
      const index = kept.length
      kept.push(item)
      coalesceSlots.set(classification.key, { index, item })
      stats.preservedRoutineBacklog += 1
    }
  }

  return { kept, dropped, coalesced, stats }
}

export function isCancelSemanticPresentationItem(item: CancelPresentationOutboundItem): boolean {
  const classification = classifyCancelReplayBacklogItem(item)
  return classification.disposition === 'preserve' && classification.semantic
}

function classifyCancelReplayBacklogItem(item: CancelPresentationOutboundItem): Classification {
  if (item.kind === 'extNotification') return classifyCancelReplayBacklogNotification(item)
  if (!item.update) return { disposition: 'drop' }

  const update = item.update as Record<string, unknown>
  const sessionUpdate = update.sessionUpdate
  const eventType =
    workflowEventType(update._meta) ?? workflowEventType(update.rawInput) ?? workflowEventType(update.rawOutput)
  if (eventType && SEMANTIC_WORKFLOW_EVENT_TYPES.has(eventType)) return { disposition: 'preserve', semantic: true }

  if (sessionUpdate === 'tool_call_update') {
    const status = typeof update.status === 'string' ? update.status : ''
    if (status === 'completed' || status === 'failed') return { disposition: 'preserve', semantic: true }
    return { disposition: 'coalesce', key: `tool:${String(update.toolCallId ?? '')}` }
  }

  if (sessionUpdate === 'tool_call') {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
    if (toolCallId.startsWith('workflow:') && !toolCallId.includes(':step:'))
      return { disposition: 'preserve', semantic: true }
    return { disposition: 'drop' }
  }

  if (sessionUpdate === 'agent_message_chunk' && isUserVisibleErrorOrWarning(update)) {
    return { disposition: 'preserve', semantic: true }
  }

  if (sessionUpdate === 'session_info_update') return { disposition: 'coalesce', key: 'session_info_update' }
  if (sessionUpdate === 'plan') return { disposition: 'coalesce', key: 'plan' }
  if (sessionUpdate === 'usage_update') return { disposition: 'coalesce', key: 'usage_update' }

  return { disposition: 'drop' }
}

function classifyCancelReplayBacklogNotification(item: CancelPresentationOutboundItem): Classification {
  if (item.method === PI_WORKFLOWS_EVENTS_METHOD) return { disposition: 'preserve', semantic: true }
  if (item.method === PI_USAGE_UPDATE_METHOD) return { disposition: 'coalesce', key: PI_USAGE_UPDATE_METHOD }
  return { disposition: 'preserve', semantic: true }
}

function isUserVisibleErrorOrWarning(update: Record<string, unknown>): boolean {
  const content = objectField(update.content)
  const text = typeof content?.text === 'string' ? content.text : ''
  return /(?:failed|error|warning|timed out|did not acknowledge|permission denied)/i.test(text)
}

function workflowEventType(value: unknown): string | undefined {
  const data = objectField(value)
  const meta = objectField(data?.piWorkflow) ?? objectField(objectField(data?._meta)?.piWorkflow)
  const eventType = meta?.eventType
  return typeof eventType === 'string' && eventType ? eventType : undefined
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
