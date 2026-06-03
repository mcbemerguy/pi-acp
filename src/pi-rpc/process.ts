import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { stripAnsi } from '../shared/ansi.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

export class PiRpcProcessLifecycleError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message)
    this.name = 'PiRpcProcessLifecycleError'
    ;(this as any).cause = opts?.cause
  }
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'steer'; id?: string; message: string; images?: unknown[] }
  | { type: 'follow_up'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  | { type: 'extension_ui_response'; id: string; cancelled?: boolean; value?: unknown; confirmed?: boolean }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Retry
  | { type: 'set_auto_retry'; id?: string; enabled: boolean }
  | { type: 'abort_retry'; id?: string }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }
  | {
      type: 'workflow_control'
      id?: string
      action: 'interrupt' | 'pause' | 'resume' | 'abort'
      target: string
      reason?: string
      policy?: 'continue-existing-session' | 'redo-step' | 'manual'
      continuationMessage?: string
    }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PendingRequest = {
  command: string
  writeCompleted: boolean
  resolve: (v: PiRpcResponse) => void
  reject: (e: unknown) => void
}

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const PROMPT_REQUEST_TIMEOUT_MS = 0
export const COMPACT_REQUEST_TIMEOUT_MS = 0
const ABORT_REQUEST_TIMEOUT_MS = 3_000
const WORKFLOW_CONTROL_REQUEST_TIMEOUT_MS = 5_000
const DIAGNOSTIC_TAIL_MAX_CHARS = 4_000
const DIAGNOSTIC_TAIL_MAX_LINES = 40

class DiagnosticTail {
  private text = ''

  push(value: unknown): void {
    const raw = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
    const cleaned = stripAnsi(raw)
    if (!cleaned) return
    this.text = (this.text + cleaned).slice(-DIAGNOSTIC_TAIL_MAX_CHARS * 2)
  }

  get(): string {
    const lines = this.text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .slice(-DIAGNOSTIC_TAIL_MAX_LINES)

    let tail = lines.join('\n')
    if (tail.length > DIAGNOSTIC_TAIL_MAX_CHARS) tail = `…${tail.slice(-DIAGNOSTIC_TAIL_MAX_CHARS)}`
    return tail
  }
}

function isStartupCommand(type: string): boolean {
  return type === 'get_state' || type === 'get_available_models'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildPiRpcSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PI_ACP: '1',
    PI_ACP_RPC: '1'
  }
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private readonly stderrTail = new DiagnosticTail()
  private readonly stdoutPreludeTail = new DiagnosticTail()
  private spawned = true
  private exited = false
  private closed = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private closeCode: number | null = null
  private closeSignal: NodeJS.Signals | null = null
  private childError: Error | null = null

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    child.stderr.on('data', chunk => this.stderrTail.push(chunk))

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) {
          this.preludeLines.push(cleaned)
          this.stdoutPreludeTail.push(`${cleaned}\n`)
        }
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        } else if (typeof msg.command === 'string') {
          const matches = Array.from(this.pending.entries()).filter(([, pending]) => pending.command === msg.command)
          if (matches.length === 1) {
            const [pendingId, pending] = matches[0]!
            this.pending.delete(pendingId)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on('exit', (code, signal) => {
      this.exited = true
      this.exitCode = code
      this.exitSignal = signal
    })

    child.on('close', (code, signal) => {
      this.closed = true
      this.closeCode = code
      this.closeSignal = signal
      this.rejectPendingForProcessExit()
    })

    child.on('error', err => {
      this.childError = err
      const wrapped = this.buildWriteFailureError('process', err)
      for (const [, p] of this.pending) p.reject(wrapped)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: buildPiRpcSpawnEnv(),
      shell: shouldUseShellForPiCommand(cmd)
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch (error) {
      if (error instanceof PiRpcProcessLifecycleError) {
        proc.dispose()
        throw error
      }
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images }, PROMPT_REQUEST_TIMEOUT_MS)
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async steer(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'steer', message, images })
    if (!res.success) throw new Error(`pi steer failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async followUp(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'follow_up', message, images })
    if (!res.success) throw new Error(`pi follow_up failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    console.error('[pi-acp] sending pi RPC abort')
    try {
      const res = await this.request({ type: 'abort' }, ABORT_REQUEST_TIMEOUT_MS)
      if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
      console.error('[pi-acp] pi RPC abort acknowledged')
    } catch (error) {
      console.error(`[pi-acp] pi RPC abort failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.writeLine({ type: 'extension_ui_response', id, ...payload }, err => {
          if (err) reject(err)
          else resolve()
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  respondExtensionUi(
    id: string,
    response: { cancelled?: boolean; value?: unknown; confirmed?: boolean } = { cancelled: true }
  ): void {
    this.writeLine({ type: 'extension_ui_response', id, ...response })
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions }, COMPACT_REQUEST_TIMEOUT_MS)
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_retry', enabled })
    if (!res.success) throw new Error(`pi set_auto_retry failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abortRetry(): Promise<void> {
    const res = await this.request({ type: 'abort_retry' })
    if (!res.success) throw new Error(`pi abort_retry failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async workflowControl(
    action: 'interrupt' | 'pause' | 'resume' | 'abort',
    target: string,
    opts: {
      reason?: string
      policy?: 'continue-existing-session' | 'redo-step' | 'manual'
      continuationMessage?: string
    } = {}
  ): Promise<unknown> {
    const res = await this.request(
      { type: 'workflow_control', action, target, ...opts },
      WORKFLOW_CONTROL_REQUEST_TIMEOUT_MS
    )
    if (!res.success) throw new Error(`pi workflow_control ${action} failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private request(cmd: PiRpcCommand, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let settled = false
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              this.pending.delete(id)
              reject(new Error(`pi RPC ${cmd.type} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          : null

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        fn()
      }

      this.pending.set(id, {
        command: cmd.type,
        writeCompleted: false,
        resolve: v => finish(() => resolve(v)),
        reject: e => finish(() => reject(e))
      })

      try {
        this.writeLine(withId, err => {
          const pending = this.pending.get(id)
          if (err) {
            this.pending.delete(id)
            finish(() => reject(err))
            return
          }
          if (pending) pending.writeCompleted = true
        })
      } catch (e) {
        this.pending.delete(id)
        finish(() => reject(e))
      }
    })
  }

  private writeLine(msg: PiRpcCommand, cb?: (err?: Error | null) => void): void {
    const guarded = this.getWriteGuardError(msg.type)
    if (guarded) {
      if (cb) {
        queueMicrotask(() => cb(guarded))
        return
      }
      throw guarded
    }

    const line = `${JSON.stringify(msg)}\n`

    try {
      this.child.stdin.write(line, err => {
        cb?.(err ? this.buildWriteFailureError(msg.type, err) : null)
      })
    } catch (error) {
      throw this.buildWriteFailureError(msg.type, error)
    }
  }

  private getWriteGuardError(command: string): Error | null {
    if (!this.spawned) return new PiRpcProcessLifecycleError(`Pi RPC process is not spawned; cannot send ${command}.`)
    if (this.exited || this.closed) return this.buildProcessExitError(command)

    const stdin = this.child.stdin
    if ((stdin as any).destroyed || !stdin.writable || stdin.writableEnded) {
      return this.buildWriteUnavailableError(command)
    }

    return null
  }

  private rejectPendingForProcessExit(): void {
    for (const [, pending] of this.pending) pending.reject(this.buildProcessExitError(pending.command, pending))
    this.pending.clear()
  }

  private buildProcessExitError(
    command: string,
    pending?: Pick<PendingRequest, 'writeCompleted'>
  ): PiRpcProcessLifecycleError {
    if (!pending) {
      const prefix = isStartupCommand(command)
        ? `Pi RPC process exited during startup before ${command} could be sent`
        : `Pi RPC process exited before ${command} could be sent`
      return new PiRpcProcessLifecycleError(`${prefix}. ${this.formatDiagnostics()}`)
    }

    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup before a response to ${command} was received`
      : `Pi RPC process exited before a response to ${command} was received`
    const delivery = pending.writeCompleted
      ? 'request write completed; delivery/processing state is ambiguous'
      : 'request write had not completed; delivery state is ambiguous'
    return new PiRpcProcessLifecycleError(`${prefix}; ${delivery}. ${this.formatDiagnostics()}`)
  }

  private buildWriteUnavailableError(command: string): PiRpcProcessLifecycleError {
    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup before ${command} could be sent`
      : `Pi RPC stdin is not writable before ${command} could be sent`
    return new PiRpcProcessLifecycleError(`${prefix}. ${this.formatDiagnostics({ includeStdin: true })}`)
  }

  private buildWriteFailureError(command: string, cause: unknown): PiRpcProcessLifecycleError {
    const message = errorMessage(cause)
    const prefix = isStartupCommand(command)
      ? `Pi RPC process exited during startup while sending ${command}`
      : `Pi RPC write failed while sending ${command}`
    return new PiRpcProcessLifecycleError(`${prefix}: ${message}. ${this.formatDiagnostics({ includeStdin: true })}`, {
      cause
    })
  }

  private formatDiagnostics(opts: { includeStdin?: boolean } = {}): string {
    const parts = [
      `process status: spawned=${this.spawned}, exited=${this.exited}, closed=${this.closed}, code=${this.exitCode}, signal=${this.exitSignal}, closeCode=${this.closeCode}, closeSignal=${this.closeSignal}`
    ]

    if (opts.includeStdin) {
      const stdin = this.child.stdin
      parts.push(
        `stdin status: writable=${stdin.writable}, destroyed=${Boolean((stdin as any).destroyed)}, writableEnded=${stdin.writableEnded}`
      )
    }

    if (this.childError) parts.push(`process error: ${errorMessage(this.childError)}`)

    const stderr = this.stderrTail.get()
    if (stderr) parts.push(`stderr tail:\n${stderr}`)

    const stdout = this.stdoutPreludeTail.get()
    if (stdout) parts.push(`stdout/prelude tail:\n${stdout}`)

    return parts.join('\n')
  }
}
