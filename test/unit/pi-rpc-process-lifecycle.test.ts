import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('PiRpcProcess: startup child exit surfaces bounded process diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-startup-exit-'))
  const piCommand = writeFakePiCommand(
    root,
    "process.stderr.write('startup failed sentinel\\n')\nsetTimeout(() => process.exit(42), 5)\n"
  )

  try {
    await assert.rejects(
      () => PiRpcProcess.spawn({ cwd: root, piCommand }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /Pi RPC process exited during startup/)
        assert.match(message, /startup failed sentinel/)
        assert.match(message, /code=42|closeCode=42/)
        assert.doesNotMatch(message, /Cannot call write after a stream was destroyed/)
        return true
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

test('PiRpcProcess: prompt exit after write reports ambiguous delivery instead of unsent prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-exit-'))
  const piCommand = writeFakePiCommand(
    root,
    `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const write = value => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.type === 'get_state') {
    write({ type: 'response', id: msg.id, command: 'get_state', success: true, data: {} })
    return
  }
  if (msg.type === 'prompt') {
    setTimeout(() => {
      process.stderr.write('prompt-exit sentinel\\n')
      process.exit(23)
    }, 20)
  }
})
`
  )

  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand })

  try {
    await assert.rejects(
      () => proc.prompt('hello'),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /before a response to prompt was received/)
        assert.match(message, /delivery\/processing state is ambiguous/)
        assert.match(message, /prompt-exit sentinel/)
        assert.match(message, /code=23|closeCode=23/)
        assert.doesNotMatch(message, /before prompt could be sent/)
        return true
      }
    )
  } finally {
    proc.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

test('PiRpcProcess: workflowControl falls back to the workflow extension command when RPC command is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-workflow-control-fallback-'))
  const messagePath = join(root, 'prompt-message.txt').replace(/\\/g, '\\\\')
  const piCommand = writeFakePiCommand(
    root,
    `import readline from 'node:readline'
import { writeFileSync } from 'node:fs'
const rl = readline.createInterface({ input: process.stdin })
const write = value => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.type === 'get_state') {
    write({ type: 'response', id: msg.id, command: 'get_state', success: true, data: {} })
    return
  }
  if (msg.type === 'workflow_control') {
    write({ type: 'response', id: msg.id, command: 'workflow_control', success: false, error: 'Unknown command: workflow_control' })
    return
  }
  if (msg.type === 'prompt') {
    writeFileSync('${messagePath}', msg.message, 'utf8')
    write({ type: 'response', id: msg.id, command: 'prompt', success: true, data: { accepted: true } })
  }
})
`
  )

  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand })

  try {
    await proc.workflowControl('resume', 'run-123', {
      reason: 'continue from ACP',
      policy: 'redo-step',
      continuationMessage: 'please continue'
    })
    const message = readFileSync(join(root, 'prompt-message.txt'), 'utf8')
    assert.match(message, /^\/workflow:control /)
    const payload = JSON.parse(Buffer.from(message.slice('/workflow:control '.length), 'base64url').toString('utf8'))
    assert.deepEqual(payload, {
      action: 'resume',
      target: 'run-123',
      reason: 'continue from ACP',
      policy: 'redo-step',
      continuationMessage: 'please continue'
    })
  } finally {
    proc.dispose('SIGKILL')
    await wait(100)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('PiRpcProcess: write after child exit fails before destroyed-stream errors and includes stderr tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-write-after-exit-'))
  const piCommand = writeFakePiCommand(
    root,
    `import readline from 'node:readline'
let answeredState = false
const rl = readline.createInterface({ input: process.stdin })
const write = value => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.type === 'get_state') {
    write({ type: 'response', id: msg.id, command: 'get_state', success: true, data: {} })
    if (!answeredState) {
      answeredState = true
      setTimeout(() => {
        process.stderr.write('write-after-exit sentinel\\n')
        process.exit(17)
      }, 10)
    }
  }
})
`
  )

  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand })

  try {
    await wait(100)
    await assert.rejects(
      () => proc.getAvailableModels(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /Pi RPC process exited during startup/)
        assert.match(message, /get_available_models/)
        assert.match(message, /write-after-exit sentinel/)
        assert.match(message, /code=17|closeCode=17/)
        assert.doesNotMatch(message, /Cannot call write after a stream was destroyed/)
        return true
      }
    )
  } finally {
    proc.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

function writeFakePiCommand(root: string, script: string): string {
  const scriptPath = join(root, 'fake-pi.mjs')
  writeFileSync(scriptPath, script, 'utf8')

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
