import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { StringDecoder } from 'node:string_decoder'
import { PiAcpAgent } from './acp/agent.js'
import { normalizeAcpInputLine } from './acp/t3code-compat.js'
import { getPiCommand, shouldUseShellForPiCommand } from './pi-rpc/command.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    let buffered = ''
    const decoder = new StringDecoder('utf8')
    const encoder = new TextEncoder()

    const enqueueLine = (line: string) => {
      controller.enqueue(encoder.encode(`${normalizeAcpInputLine(line)}\n`))
    }

    process.stdin.on('data', (chunk: Buffer) => {
      buffered += decoder.write(chunk)
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) enqueueLine(line)
    })
    process.stdin.on('end', () => {
      buffered += decoder.end()
      if (buffered) enqueueLine(buffered)
      controller.close()
    })
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

const agent = new AgentSideConnection(conn => new PiAcpAgent(conn), stream)

function shutdown() {
  try {
    // Best-effort: dispose session subprocesses when the client disconnects.
    ;(agent as any)?.agent?.dispose?.()
  } catch {
    // ignore
  }
  try {
    process.exit(0)
  } catch {
    // ignore
  }
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', () => {
  try {
    process.exit(0)
  } catch {
    // ignore
  }
})
