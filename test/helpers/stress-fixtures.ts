import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

export type StressFixture<T> = {
  records: T[]
  ndjson: string
  bytes: number
}

export function makePiTextDeltaEvents(count: number, payloadSize = 24): StressFixture<PiRpcEvent> {
  const payload = 'x'.repeat(payloadSize)
  const records: PiRpcEvent[] = Array.from({ length: count }, (_, sequence) => ({
    type: 'message_update',
    sequence,
    assistantMessageEvent: {
      type: 'text_delta',
      delta: `chunk-${sequence}-${payload}`
    }
  }))
  return fixtureFromRecords(records)
}

export function makeWorkflowFinalTextRecords(count: number, payloadSize = 24): StressFixture<Record<string, unknown>> {
  const payload = 'w'.repeat(payloadSize)
  const records: Record<string, unknown>[] = [
    {
      type: 'run_start',
      sequence: 0,
      timestamp: '2026-05-26T00:00:00.000Z',
      runId: 'stress-run',
      workflowId: 'stress',
      commandName: 'workflow:stress',
      cwd: '/repo',
      status: 'running'
    },
    ...Array.from({ length: count }, (_, index) => ({
      type: 'child_pi_event',
      sequence: index + 1,
      timestamp: `2026-05-26T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      runId: 'stress-run',
      workflowId: 'stress',
      commandName: 'workflow:stress',
      cwd: '/repo',
      stepId: 'code',
      childSessionId: 'child-1',
      childEventType: 'message_end',
      event: {
        type: 'message_end',
        messageId: `m-${index}`,
        message: {
          id: `m-${index}`,
          role: 'assistant',
          content: [{ type: 'text', text: `workflow-chunk-${index}-${payload}` }]
        }
      }
    })),
    {
      type: 'run_end',
      sequence: count + 1,
      timestamp: '2026-05-26T00:10:00.000Z',
      runId: 'stress-run',
      workflowId: 'stress',
      commandName: 'workflow:stress',
      cwd: '/repo',
      status: 'completed'
    }
  ]
  return fixtureFromRecords(records)
}

export function fixtureFromRecords<T>(records: T[]): StressFixture<T> {
  const ndjson = records.map(record => JSON.stringify(record)).join('\n') + '\n'
  return { records, ndjson, bytes: Buffer.byteLength(ndjson) }
}
