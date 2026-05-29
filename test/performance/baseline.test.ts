import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PiAcpSession } from '../../src/acp/session.js'
import { WorkflowEventMonitor } from '../../src/acp/workflow-events.js'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'
import { asAgentConn, FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'
import { makePiTextDeltaEvents, makeWorkflowTextDeltaRecords } from '../helpers/stress-fixtures.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error('timed out waiting for stress fixture condition')
    await wait(5)
  }
}

test('baseline: Pi RPC stdout ingestion observes every generated event in order', async () => {
  const fixture = makePiTextDeltaEvents(1_500, 32)
  const root = join(tmpdir(), `pi-acp-rpc-stress-${process.pid}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  const piCommand = writeFakePiCommand(root, fixture.records)
  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand })
  const observed: PiRpcEvent[] = []
  proc.onEvent(event => observed.push(event))

  try {
    const startedAt = performance.now()
    await proc.prompt('stress')
    const latencyMs = performance.now() - startedAt

    assert.equal(observed.length, fixture.records.length)
    assert.deepEqual(
      observed.map(event => event.sequence),
      fixture.records.map(event => event.sequence)
    )
    assert.equal(JSON.stringify(observed[0]), JSON.stringify(fixture.records[0]))

    console.log(
      JSON.stringify({
        fixture: 'pi-rpc-stdout',
        events: fixture.records.length,
        bytes: fixture.bytes,
        promptCompletionLatencyMs: Math.round(latencyMs)
      })
    )
  } finally {
    proc.dispose()
    await wait(50)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

test('phase 4: ACP session outbound pressure coalesces presentation text after ingestion accounting', async () => {
  const fixture = makePiTextDeltaEvents(2_000, 48)
  const conn = new FakeAgentSideConnection()
  let unblock!: () => void
  const blocker = new Promise<void>(resolve => {
    unblock = resolve
  })
  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    await blocker
    await originalSessionUpdate(message)
  }
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'stress-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('stress')
  proc.emit({ type: 'agent_start' })
  for (const record of fixture.records) proc.emit(record)

  const beforeEnd = session.getOutboundPressureSnapshot()
  assert.equal(beforeEnd.enqueued, fixture.records.length + 1)
  assert.ok(beforeEnd.maxPending < 10, `expected bounded pending ACP updates, got ${beforeEnd.maxPending}`)
  assert.equal(beforeEnd.completed, 0)
  assert.ok(beforeEnd.coalesced > 0)

  const agentEndAt = performance.now()
  proc.emit({ type: 'agent_end' })
  await wait(20)
  const blocked = session.getOutboundPressureSnapshot()
  assert.ok(blocked.pending < 10, `expected bounded blocked ACP updates, got ${blocked.pending}`)
  assert.equal(blocked.enqueued, fixture.records.length + 1)

  unblock()
  const reason = await prompt
  const promptCompletionLatencyMs = performance.now() - agentEndAt
  assert.equal(reason, 'end_turn')
  await waitUntil(() => {
    const snapshot = session.getOutboundPressureSnapshot()
    return snapshot.pending === 0
  })

  const textChunks = conn.updates.flatMap(message => {
    const update: any = message.update
    return update.sessionUpdate === 'agent_message_chunk' &&
      update.content?.type === 'text' &&
      update.content.text.startsWith('chunk-')
      ? [String(update.content.text)]
      : []
  })

  assert.equal(
    textChunks.join(''),
    fixture.records.map(record => String((record.assistantMessageEvent as { delta: string }).delta)).join('')
  )

  const finalPressure = session.getOutboundPressureSnapshot()
  console.log(
    JSON.stringify({
      fixture: 'acp-session-outbound',
      events: fixture.records.length,
      bytes: fixture.bytes,
      maxQueueDepth: finalPressure.maxPending,
      coalesced: finalPressure.coalesced,
      sentUpdates: conn.updates.length,
      sourceUpdatesAccounted: finalPressure.enqueued,
      promptCompletionLatencyMs: Math.round(promptCompletionLatencyMs)
    })
  )
})

test('phase 4: ACP session outbound pressure coalesces thought chunks without message ids', async () => {
  const records: PiRpcEvent[] = Array.from({ length: 300 }, (_, sequence) => ({
    type: 'message_update',
    sequence,
    assistantMessageEvent: {
      type: 'thinking_delta',
      delta: `thought-${sequence}-`
    }
  }))
  const conn = new FakeAgentSideConnection()
  let unblock!: () => void
  const blocker = new Promise<void>(resolve => {
    unblock = resolve
  })
  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    await blocker
    await originalSessionUpdate(message)
  }
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'thought-stress-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('stress thoughts')
  proc.emit({ type: 'agent_start' })
  for (const record of records) proc.emit(record)

  const blocked = session.getOutboundPressureSnapshot()
  assert.equal(blocked.enqueued, records.length + 1)
  assert.ok(blocked.maxPending < 10, `expected bounded pending thought ACP updates, got ${blocked.maxPending}`)
  assert.ok(blocked.coalesced > 0)
  assert.equal(blocked.diagnostics, 0)

  proc.emit({ type: 'agent_end' })
  unblock()
  assert.equal(await prompt, 'end_turn')
  await waitUntil(() => session.getOutboundPressureSnapshot().pending === 0)

  const thoughtText = conn.updates
    .flatMap(message => {
      const update: any = message.update
      return update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text'
        ? [String(update.content.text)]
        : []
    })
    .join('')
  assert.equal(
    thoughtText,
    records.map(record => String((record.assistantMessageEvent as { delta: string }).delta)).join('')
  )
})

test('phase 4: outbound diagnostics are included in enqueue accounting', async () => {
  const records: PiRpcEvent[] = Array.from({ length: 260 }, (_, sequence) => ({
    type: 'tool_execution_start',
    sequence,
    toolCallId: `tool-${sequence}`,
    toolName: 'read',
    args: { path: `file-${sequence}.txt` }
  }))
  const conn = new FakeAgentSideConnection()
  let unblock!: () => void
  const blocker = new Promise<void>(resolve => {
    unblock = resolve
  })
  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    await blocker
    await originalSessionUpdate(message)
  }
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'diagnostic-accounting-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const prompt = session.prompt('stress tool calls')
  proc.emit({ type: 'agent_start' })
  for (const record of records) proc.emit(record)

  const blocked = session.getOutboundPressureSnapshot()
  assert.equal(blocked.diagnostics, 1)
  assert.equal(blocked.enqueued, records.length + 2)
  assert.ok(blocked.pending <= blocked.enqueued)
  assert.ok(blocked.completed <= blocked.enqueued)

  proc.emit({ type: 'agent_end' })
  unblock()
  assert.equal(await prompt, 'end_turn')
  await waitUntil(() => session.getOutboundPressureSnapshot().pending === 0)

  const finalPressure = session.getOutboundPressureSnapshot()
  assert.ok(finalPressure.completed <= finalPressure.enqueued)
})

test('baseline: workflow monitor observes every JSONL event in order before mapping to ACP updates', async () => {
  const fixture = makeWorkflowTextDeltaRecords(1_200, 40)
  const root = join(tmpdir(), `pi-acp-workflow-stress-${process.pid}-${Date.now()}`)
  const workflowRunsDir = join(root, 'workflow-runs')
  const runDir = join(workflowRunsDir, 'stress-run')
  mkdirSync(workflowRunsDir, { recursive: true })
  const observedSequences: number[] = []
  const updates: any[] = []
  const monitor = new WorkflowEventMonitor('/repo', update => updates.push(update), {
    workflowRunsDir,
    pollIntervalMs: 5,
    graceMs: 20,
    onRecord: record => observedSequences.push(Number(record.sequence))
  })

  try {
    monitor.start()
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'events.jsonl'), fixture.ndjson, 'utf8')
    await waitUntil(() => monitor.getIngestionSnapshot().recordsObserved === fixture.records.length)
    await monitor.waitForRunEndAfterPromptResolution()

    assert.deepEqual(
      observedSequences,
      fixture.records.map(record => Number(record.sequence))
    )

    const textChunks = updates
      .filter(
        update =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text.startsWith('workflow-chunk-')
      )
      .map(update => update.content.text)
    assert.deepEqual(
      textChunks,
      fixture.records
        .filter(record => record.type === 'child_pi_event')
        .map(record => {
          const event = record.event as { assistantMessageEvent: { delta: string } }
          return event.assistantMessageEvent.delta
        })
    )

    const snapshot = monitor.getIngestionSnapshot()
    assert.equal(snapshot.recordsObserved, fixture.records.length)
    assert.equal(snapshot.newBytesObserved, fixture.bytes)
    assert.ok(snapshot.fileBytesRead >= fixture.bytes)
    assert.equal(snapshot.malformedLines, 0)

    console.log(
      JSON.stringify({
        fixture: 'workflow-jsonl-tail',
        events: snapshot.recordsObserved,
        bytes: snapshot.newBytesObserved,
        fileBytesRead: snapshot.fileBytesRead,
        maxActiveTails: snapshot.maxActiveTails
      })
    )
  } finally {
    monitor.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

function writeFakePiCommand(root: string, records: PiRpcEvent[]): string {
  const scriptPath = join(root, 'fake-pi.mjs')
  writeFileSync(
    scriptPath,
    `import readline from 'node:readline'\nconst records = ${JSON.stringify(records)}\nconst rl = readline.createInterface({ input: process.stdin })\nconst write = value => process.stdout.write(JSON.stringify(value) + '\\n')\nrl.on('line', line => {\n  const msg = JSON.parse(line)\n  if (msg.type === 'get_state') write({ type: 'response', id: msg.id, command: 'get_state', success: true, data: {} })\n  else if (msg.type === 'prompt') {\n    for (const record of records) write(record)\n    write({ type: 'response', id: msg.id, command: 'prompt', success: true, data: null })\n    setTimeout(() => process.exit(0), 10)\n  } else if (msg.type === 'abort') write({ type: 'response', id: msg.id, command: 'abort', success: true, data: null })\n})\n`,
    'utf8'
  )

  if (process.platform === 'win32') {
    const cmdPath = join(root, 'fake-pi.cmd')
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8')
    return cmdPath
  }

  const shPath = join(root, 'fake-pi')
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8')
  chmodSync(shPath, 0o755)
  return shPath
}
