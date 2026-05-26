import { spawn } from 'node:child_process'

const cwd = process.cwd()
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmSpawnOptions = { stdio: 'inherit', cwd, shell: process.platform === 'win32' }

// Build first so Zed-style invocation (node dist/index.js) works.
await new Promise((resolve, reject) => {
  const p = spawn(npmCommand, ['run', 'build'], npmSpawnOptions)
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
})

const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  process.stdout.write(chunk)
})

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

// Basic ACP handshake + one prompt.
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: cwd, mcpServers: [] } })

// We'll send prompt a moment later; sessionId is in response to id=2.
let sessionId = null
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg?.id === 2 && msg?.result?.sessionId && !sessionId) {
      const result = msg.result
      const configOptions = Array.isArray(result.configOptions) ? result.configOptions : []
      const categories = configOptions.map(option => option.category)

      if (Object.prototype.hasOwnProperty.call(result, 'models')) {
        throw new Error('session/new unexpectedly returned experimental models field')
      }
      if (Object.prototype.hasOwnProperty.call(result, 'modes')) {
        throw new Error('session/new unexpectedly returned experimental modes field')
      }
      if (!categories.includes('model')) {
        throw new Error('session/new did not return model config option')
      }
      if (!categories.includes('thought_level')) {
        throw new Error('session/new did not return thought_level config option')
      }

      sessionId = result.sessionId
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'Say hello in one short sentence.' }]
        }
      })
    }

    if (msg?.id === 3) {
      // Turn finished.
      setTimeout(() => child.kill('SIGTERM'), 50)
    }
  }
})
