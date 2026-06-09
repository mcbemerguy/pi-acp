import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { PiAcpSession, SessionManager } from './session.js'
import { SessionStore, type StoredSession } from './session-store.js'
import { PiRpcProcess, PiRpcProcessLifecycleError, PiRpcSpawnError } from '../pi-rpc/process.js'
import {
  allowsAdapterProjectLocalReads,
  resolveProjectTrustPolicy,
  type PiProjectTrustConfig,
  type PiProjectTrustPolicy
} from '../pi-rpc/trust.js'
import { findPiSessionFile, listPiSessions, resolveStoredPiSessionFile, validatePiSessionFile } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import { toToolKind } from './translate/tool-metadata.js'
import { promptToPiMessage } from './translate/prompt.js'
import { zContentBlock } from '@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getEnableSkillCommands } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { PI_EXTENSION_UI_EVENT_METHOD } from './extension-ui.js'
import { PI_USAGE_UPDATE_METHOD, usageFromPiSessionStats } from './usage.js'
import {
  PI_WORKFLOW_METHODS,
  PI_WORKFLOWS_ABORT_METHOD,
  PI_WORKFLOWS_EVENTS_METHOD,
  PI_WORKFLOWS_GET_METHOD,
  PI_WORKFLOWS_INTERRUPT_METHOD,
  PI_WORKFLOWS_LIST_METHOD,
  PI_WORKFLOWS_PAUSE_METHOD,
  PI_WORKFLOWS_RESUME_METHOD,
  abortWorkflowRun,
  interruptWorkflowRun,
  isRecoverableWorkflowStatus,
  listRecoverableWorkflowRunsForSession,
  listWorkflowRuns,
  pauseWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
  resumeWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunStatus
} from './workflows.js'
import {
  getSessionConfigOptions,
  isThinkingLevel,
  MODEL_CONFIG_ID,
  resolveModelSelection,
  THINKING_CONFIG_ID
} from './session-config.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

async function refreshSessionUsageInputsIfAvailable(
  session: unknown,
  opts: { includeState?: boolean; force?: boolean } = {}
): Promise<{ stats?: unknown; state?: unknown }> {
  const candidate = session as {
    refreshUsageTelemetry?: (opts?: {
      includeState?: boolean
      force?: boolean
    }) => Promise<{ stats?: unknown; state?: unknown }>
    publishUsageUpdateFromStats?: (stats: unknown, opts?: { force?: boolean }) => void
    publishPiUsageTelemetryFromStats?: (stats: unknown, state?: unknown, opts?: { force?: boolean }) => void
    proc?: Pick<PiRpcProcess, 'getSessionStats' | 'getState'>
  }

  if (typeof candidate.refreshUsageTelemetry === 'function') {
    return candidate.refreshUsageTelemetry(opts)
  }

  const [stats, state] = await Promise.all([
    candidate.proc?.getSessionStats().catch(() => undefined) ?? Promise.resolve(undefined),
    opts.includeState ? (candidate.proc?.getState().catch(() => undefined) ?? Promise.resolve(undefined)) : undefined
  ])

  if (stats !== undefined) {
    candidate.publishUsageUpdateFromStats?.(stats, { force: opts.force })
    candidate.publishPiUsageTelemetryFromStats?.(stats, state, { force: opts.force })
  }

  return { stats, state }
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}

export async function discoverAvailableCommands(
  proc: Pick<PiRpcProcess, 'getCommands'>,
  fileCommands: ReturnType<typeof loadSlashCommands>,
  _enableSkillCommands: boolean
): Promise<AvailableCommand[]> {
  try {
    const pi = (await proc.getCommands()) as unknown
    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
      includeExtensionCommands: true
    })

    return mergeCommands(commands, builtinAvailableCommands())
  } catch {
    return mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
  }
}
import { fileURLToPath } from 'node:url'

const PI_STEER_METHOD = '_pi/steer'
const PI_SESSION_DELETE_METHOD = '_pi/session/delete'

type PiSteerParams = {
  sessionId: string
  prompt: ContentBlock[]
  mode: 'steer' | 'follow_up'
}

type DeletePiSessionFileCleanup =
  | { status: 'deleted'; sessionFile: string; cwd: string }
  | { status: 'missing'; sessionFile: string }
  | { status: 'not_found'; refused: Array<{ sessionFile: string; reason: string }> }

type DeleteWorkflowCleanup = {
  abortedRunIds: string[]
  failures: Array<{ runId: string; error: string }>
}

const pkg = readNearestPackageJson(import.meta.url)

function shouldReplayLoadSessionHistory(params: InitializeRequest): boolean {
  const clientName = (params.clientInfo?.name ?? '').trim().toLowerCase()

  return clientName !== 't3-code' && clientName !== 't3code'
}

function compactError(error: unknown): RequestError {
  const message = error instanceof Error ? error.message : String(error)
  return RequestError.internalError({ details: message }, message)
}

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly config: PiProjectTrustConfig | null
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private replayLoadSessionHistory = true

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, config?: PiProjectTrustConfig | null) {
    this.conn = conn
    this.config = config ?? null
  }

  private projectTrustPolicyForRequest(params: { _meta?: unknown }): PiProjectTrustPolicy {
    return resolveProjectTrustPolicy({ requestMeta: params._meta, config: this.config })
  }

  private allowsProjectLocalReads(policy: PiProjectTrustPolicy): boolean {
    return allowsAdapterProjectLocalReads(policy)
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private refreshSessionMapFromPiState(
    sessionId: string,
    cwd: string,
    state: unknown,
    session?: { updateSessionFile(sessionFile: string | null): void }
  ): string | null {
    const stateSessionId = this.stateString(state, 'sessionId')
    const sessionFile = this.stateString(state, 'sessionFile')

    if (stateSessionId && stateSessionId !== sessionId) return null
    if (!sessionFile) return null

    if (existsSync(sessionFile)) {
      const validation = validatePiSessionFile(sessionFile, { sessionId, cwd })
      if (!validation.ok) return null
    }

    this.store.upsert({ sessionId, cwd, sessionFile })
    session?.updateSessionFile(sessionFile)
    return sessionFile
  }

  private stateString(state: unknown, key: string): string | null {
    const data = state && typeof state === 'object' ? (state as Record<string, unknown>) : null
    const value = data?.[key]
    return typeof value === 'string' && value.trim() ? value : null
  }

  private upsertKnownSessionFile(
    sessionId: string,
    cwd: string,
    sessionFile: string | null | undefined,
    session?: { updateSessionFile(sessionFile: string | null): void }
  ): boolean {
    if (!sessionFile || !existsSync(sessionFile)) return false
    const validation = validatePiSessionFile(sessionFile, { sessionId, cwd })
    if (!validation.ok) return false
    this.store.upsert({ sessionId, cwd, sessionFile })
    session?.updateSessionFile(sessionFile)
    return true
  }

  private async getReusableActiveLoadState(
    session: PiAcpSession,
    params: Pick<LoadSessionRequest, 'sessionId' | 'cwd'>
  ): Promise<{ reusable: true; state: unknown } | { reusable: false }> {
    if (session.cwd !== params.cwd) return { reusable: false }

    let state: unknown
    try {
      state = await session.proc.getState()
    } catch {
      return { reusable: false }
    }

    const stateSessionId = this.stateString(state, 'sessionId')
    if (stateSessionId && stateSessionId !== params.sessionId) return { reusable: false }

    const stateCwd = this.stateString(state, 'cwd')
    if (stateCwd && stateCwd !== params.cwd) return { reusable: false }

    const stateSessionFile = this.stateString(state, 'sessionFile')
    if (stateSessionFile && existsSync(stateSessionFile)) {
      const validation = validatePiSessionFile(stateSessionFile, { sessionId: params.sessionId, cwd: params.cwd })
      if (!validation.ok) return { reusable: false }
    }

    const knownSessionFile = stateSessionFile ?? session.getSessionFile()
    if (knownSessionFile && existsSync(knownSessionFile)) {
      const validation = validatePiSessionFile(knownSessionFile, { sessionId: params.sessionId, cwd: params.cwd })
      if (!validation.ok) return { reusable: false }
    }

    return { reusable: true, state }
  }

  private async attachRecoverableWorkflowRuns(
    session: PiAcpSession,
    cwd: string,
    parentSessionId: string
  ): Promise<void> {
    const recoverableWorkflowRuns = listRecoverableWorkflowRunsForSession({ cwd, parentSessionId })
    for (const run of recoverableWorkflowRuns) await session.attachWorkflowRun(run, 0)
  }

  private scheduleAvailableCommandsUpdate(
    sessionId: string,
    proc: Pick<PiRpcProcess, 'getCommands'>,
    fileCommands: ReturnType<typeof loadSlashCommands>,
    enableSkillCommands: boolean
  ): void {
    setTimeout(() => {
      void (async () => {
        const availableCommands = await discoverAvailableCommands(proc, fileCommands, enableSkillCommands)

        await this.conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands
          }
        })
      })().catch(error => {
        console.error(
          `[pi-acp] available commands update failed sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }, 0)
  }

  private async buildLoadSessionResponse(
    session: PiAcpSession,
    params: Pick<LoadSessionRequest, 'sessionId' | 'cwd'>,
    fileCommands: ReturnType<typeof loadSlashCommands>,
    enableSkillCommands: boolean,
    state?: unknown
  ): Promise<LoadSessionResponse> {
    session.updateFileCommands(fileCommands)

    if (!this.refreshSessionMapFromPiState(params.sessionId, params.cwd, state, session)) {
      this.upsertKnownSessionFile(params.sessionId, params.cwd, session.getSessionFile(), session)
    }

    await this.attachRecoverableWorkflowRuns(session, params.cwd, params.sessionId)

    const configOptions = await getSessionConfigOptions(session.proc, { state })

    const response = {
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    this.scheduleAvailableCommandsUpdate(session.sessionId, session.proc, fileCommands, enableSkillCommands)

    return response
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion
    this.replayLoadSessionHistory = shouldReplayLoadSessionHistory(params)

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // Enables a native session picker in clients that support session/list.
          list: {},
          close: {}
        },
        _meta: {
          piAcp: {
            sessionDelete: true,
            sessionDeleteMethod: PI_SESSION_DELETE_METHOD,
            extensionUiEvents: true,
            extensionUiEventMethod: PI_EXTENSION_UI_EVENT_METHOD,
            usageTelemetry: true,
            usageTelemetryMethod: PI_USAGE_UPDATE_METHOD,
            steering: true,
            steeringMethod: PI_STEER_METHOD,
            steeringModes: ['steer', 'follow_up'],
            workflows: true,
            workflowMethods: PI_WORKFLOW_METHODS,
            workflowEventsMethod: PI_WORKFLOWS_EVENTS_METHOD
          }
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const projectTrustPolicy = this.projectTrustPolicyForRequest(params as { _meta?: unknown })
    const allowProjectLocalReads = this.allowsProjectLocalReads(projectTrustPolicy)
    const fileCommands = loadSlashCommands(params.cwd, { includeProject: allowProjectLocalReads })
    const enableSkillCommands = getEnableSkillCommands(params.cwd, { includeProject: allowProjectLocalReads })

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      projectTrustPolicy
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    this.refreshSessionMapFromPiState(session.sessionId, session.cwd, state, session)

    const configOptions = await getSessionConfigOptions(session.proc, { state, availableModels })

    // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
    // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
    // It does NOT affect other client windows because they run in separate agent processes.
    //
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    this.scheduleAvailableCommandsUpdate(session.sessionId, session.proc, fileCommands, enableSkillCommands)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        let res: unknown
        try {
          res = await session.proc.compact(customInstructions)
        } catch (error) {
          throw compactError(error)
        }

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const { stats } = await refreshSessionUsageInputsIfAvailable(session, { includeState: true, force: true })
        if (stats === undefined) throw RequestError.internalError({}, 'pi get_session_stats failed')
        const statsRecord = stats && typeof stats === 'object' ? (stats as Record<string, unknown>) : null

        const lines: string[] = []
        if (typeof statsRecord?.sessionId === 'string') lines.push(`Session: ${statsRecord.sessionId}`)
        if (typeof statsRecord?.sessionFile === 'string') lines.push(`Session file: ${statsRecord.sessionFile}`)
        if (typeof statsRecord?.totalMessages === 'number') lines.push(`Messages: ${statsRecord.totalMessages}`)

        if (typeof statsRecord?.cost === 'number') lines.push(`Cost: ${statsRecord.cost}`)

        const t = statsRecord?.tokens
        if (t && typeof t === 'object' && !Array.isArray(t)) {
          const tokens = t as Record<string, unknown>
          const parts: string[] = []
          if (typeof tokens.input === 'number') parts.push(`in ${tokens.input}`)
          if (typeof tokens.output === 'number') parts.push(`out ${tokens.output}`)
          if (typeof tokens.cacheRead === 'number') parts.push(`cache read ${tokens.cacheRead}`)
          if (typeof tokens.cacheWrite === 'number') parts.push(`cache write ${tokens.cacheWrite}`)
          if (typeof tokens.total === 'number') parts.push(`total ${tokens.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const continuation = this.resolveWorkflowContinuation(session.sessionId, session.cwd, message, images)
    if (continuation.kind === 'ambiguous') {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: continuation.message }
        }
      })
      return { stopReason: 'end_turn' }
    }

    const result =
      continuation.kind === 'resume'
        ? await session.continueWorkflowRun(continuation.run, message, { reason: 'ACP prompt continuation' })
        : await session.prompt(message, images, {
            onAccepted: state => {
              this.refreshSessionMapFromPiState(session.sessionId, session.cwd, state, session)
            }
          })

    if (result === 'cancelled' || (result === 'error' && session.wasCancelRequested())) {
      return { stopReason: 'cancelled' }
    }

    const { stats, state } = await refreshSessionUsageInputsIfAvailable(session, { includeState: true, force: true })
    this.refreshSessionMapFromPiState(session.sessionId, session.cwd, state, session)
    const usage = usageFromPiSessionStats(stats)

    if (result === 'error') {
      throw RequestError.internalError({}, 'Pi prompt failed before completing the turn.')
    }

    const stopReason: StopReason = result

    return { stopReason, ...(usage ? { usage } : {}) }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.closeManagedSession(params.sessionId)
    return {}
  }

  async unstable_deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    return this.deleteBackingSession(params, 'session/delete')
  }

  private async deleteBackingSession(params: DeleteSessionRequest, method: string): Promise<DeleteSessionResponse> {
    const sessionId = params.sessionId
    const active = this.sessions.maybeGet(sessionId)
    const stored = this.getStoredSessionForDelete(sessionId)
    const activeCwd = active?.cwd ?? null
    const activeSessionFile = active?.getSessionFile() ?? null
    const expectedCwd = activeCwd ?? stored?.cwd ?? this.lastSessionCwd

    console.error(
      `[pi-acp] ${method} requested sessionId=${sessionId} active=${Boolean(active)} stored=${Boolean(stored)} expectedCwd=${expectedCwd ?? 'unknown'} activeSessionFile=${activeSessionFile ?? 'none'} storedSessionFile=${stored?.sessionFile ?? 'none'}`
    )

    try {
      await this.closeManagedSession(sessionId)
    } catch (error) {
      const message = `Failed to close session before delete for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      console.error(`[pi-acp] ${method} close failed sessionId=${sessionId}: ${message}`)
      throw RequestError.internalError({}, message)
    }

    let sessionFileCleanup: DeletePiSessionFileCleanup
    try {
      sessionFileCleanup = this.deleteValidatedPiSessionFile({
        method,
        sessionId,
        expectedCwd,
        activeSessionFile,
        storedSessionFile: stored?.sessionFile ?? null
      })
    } catch (error) {
      const message = `Failed to delete session file for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      throw RequestError.internalError({}, message)
    }

    this.store.delete(sessionId)

    const workflowCwd =
      activeCwd ??
      stored?.cwd ??
      (sessionFileCleanup.status === 'deleted' ? sessionFileCleanup.cwd : null) ??
      expectedCwd
    const workflows = workflowCwd
      ? this.abortRecoverableWorkflowRunsForDeletedSession(sessionId, workflowCwd, method)
      : { abortedRunIds: [], failures: [] }

    return {
      _meta: {
        piAcp: {
          deleteCleanup: {
            close: { active: Boolean(active), attempted: true, ok: true },
            sessionFile: sessionFileCleanup,
            sessionMap: { removedSessionId: sessionId },
            workflows
          }
        }
      }
    }
  }

  private async closeManagedSession(sessionId: string): Promise<void> {
    if (typeof (this.sessions as any).closeSession === 'function') {
      await (this.sessions as any).closeSession(sessionId)
      return
    }

    this.sessions.close(sessionId)
  }

  private getStoredSessionForDelete(sessionId: string): StoredSession | null {
    const store = this.store as SessionStore & { getIncludingMissing?: (sessionId: string) => StoredSession | null }
    return typeof store.getIncludingMissing === 'function' ? store.getIncludingMissing(sessionId) : store.get(sessionId)
  }

  private deleteValidatedPiSessionFile(opts: {
    method: string
    sessionId: string
    expectedCwd?: string | null
    activeSessionFile?: string | null
    storedSessionFile?: string | null
  }): DeletePiSessionFileCleanup {
    const candidates: Array<{ file: string; cwd?: string | null }> = []
    const addCandidate = (file: string | null | undefined, cwd?: string | null) => {
      if (!file || !file.trim()) return
      if (candidates.some(candidate => candidate.file === file)) return
      candidates.push({ file, cwd })
    }

    addCandidate(opts.activeSessionFile, opts.expectedCwd)
    addCandidate(opts.storedSessionFile, opts.expectedCwd)
    addCandidate(findPiSessionFile(opts.sessionId, opts.expectedCwd), opts.expectedCwd)
    if (!opts.expectedCwd) addCandidate(findPiSessionFile(opts.sessionId), null)

    const refused: Array<{ sessionFile: string; reason: string }> = []

    for (const candidate of candidates) {
      const validation = validatePiSessionFile(candidate.file, { sessionId: opts.sessionId, cwd: candidate.cwd })
      if (!validation.ok) {
        refused.push({ sessionFile: candidate.file, reason: validation.reason })
        console.error(
          `[pi-acp] ${opts.method} refused to unlink invalid session file sessionId=${opts.sessionId} file=${candidate.file} reason=${validation.reason}`
        )
        continue
      }

      console.error(
        `[pi-acp] ${opts.method} resolved pi session file sessionId=${opts.sessionId} file=${validation.sessionFile} cwd=${validation.header.cwd}`
      )

      try {
        unlinkSync(validation.sessionFile)
        console.error(
          `[pi-acp] ${opts.method} unlinked pi session file sessionId=${opts.sessionId} file=${validation.sessionFile}`
        )
      } catch (error) {
        console.error(
          `[pi-acp] ${opts.method} failed to unlink pi session file sessionId=${opts.sessionId} file=${validation.sessionFile}: ${error instanceof Error ? error.message : String(error)}`
        )
        throw error
      }
      return { status: 'deleted', sessionFile: validation.sessionFile, cwd: validation.header.cwd }
    }

    const missing = refused.find(item => item.reason === 'missing')
    if (missing && refused.every(item => item.reason === 'missing')) {
      console.error(
        `[pi-acp] ${opts.method} backing pi session file missing sessionId=${opts.sessionId} file=${missing.sessionFile}`
      )
      return { status: 'missing', sessionFile: missing.sessionFile }
    }

    console.error(`[pi-acp] ${opts.method} found no validated pi session file sessionId=${opts.sessionId}`)
    return { status: 'not_found', refused }
  }

  private abortRecoverableWorkflowRunsForDeletedSession(
    sessionId: string,
    cwd: string,
    method: string
  ): DeleteWorkflowCleanup {
    const runs = listRecoverableWorkflowRunsForSession({ cwd, parentSessionId: sessionId })
    const cleanup: DeleteWorkflowCleanup = { abortedRunIds: [], failures: [] }
    for (const run of runs) {
      if (!isRecoverableWorkflowStatus(run.status)) continue
      try {
        const next = abortWorkflowRun(run.runDir || run.id, { reason: 'Parent ACP session was deleted.' })
        if (next.status === 'aborted') cleanup.abortedRunIds.push(run.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        cleanup.failures.push({ runId: run.id, error: message })
        console.error(
          `[pi-acp] ${method} failed to abort workflow run sessionId=${sessionId} runId=${run.id}: ${message}`
        )
      }
    }
    return cleanup
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === PI_SESSION_DELETE_METHOD) {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
      if (!sessionId) throw RequestError.invalidParams({}, 'sessionId must be a non-empty string')
      return this.deleteBackingSession({ sessionId }, method)
    }

    if (method === PI_STEER_METHOD) {
      const steerParams = this.parsePiSteerParams(params)
      const session = this.sessions.get(steerParams.sessionId)
      const { message, images } = promptToPiMessage(steerParams.prompt)

      if (steerParams.mode === 'steer') await session.proc.steer(message, images)
      else await session.proc.followUp(message, images)

      return { accepted: true, mode: steerParams.mode }
    }

    if (PI_WORKFLOW_METHODS.includes(method as (typeof PI_WORKFLOW_METHODS)[number])) {
      return this.handleWorkflowMethod(method, params)
    }

    throw RequestError.methodNotFound(method)
  }

  private async handleWorkflowMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      switch (method) {
        case PI_WORKFLOWS_LIST_METHOD: {
          const session = typeof params.sessionId === 'string' ? this.sessions.maybeGet(params.sessionId) : undefined
          const status = parseWorkflowStatusFilter(params.status)
          const runs = listWorkflowRuns({
            cwd: stringParam(params.cwd) ?? session?.cwd ?? this.lastSessionCwd ?? undefined,
            parentSessionId: stringParam(params.parentSessionId) ?? session?.sessionId,
            status,
            limit: numberParam(params.limit)
          })
          return { runs }
        }
        case PI_WORKFLOWS_GET_METHOD:
          return { run: readWorkflowRun(workflowTargetParam(params)) }
        case PI_WORKFLOWS_EVENTS_METHOD:
          return {
            ...readWorkflowRunEvents(workflowTargetParam(params), {
              sinceSequence: numberParam(params.sinceSequence),
              offset: numberParam(params.offset),
              limit: numberParam(params.limit),
              includeTerminalFallback: params.includeTerminalFallback !== false
            })
          }
        case PI_WORKFLOWS_INTERRUPT_METHOD:
          return this.handleWorkflowControl('interrupt', params)
        case PI_WORKFLOWS_PAUSE_METHOD:
          return this.handleWorkflowControl('pause', params)
        case PI_WORKFLOWS_RESUME_METHOD:
          return this.handleWorkflowControl('resume', params)
        case PI_WORKFLOWS_ABORT_METHOD:
          return this.handleWorkflowControl('abort', params)
        default:
          throw RequestError.methodNotFound(method)
      }
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw compactError(error)
    }
  }

  private async handleWorkflowControl(
    action: 'interrupt' | 'pause' | 'resume' | 'abort',
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const target = workflowTargetParam(params)
    const opts = {
      reason: stringParam(params.reason),
      policy: action === 'resume' ? parseWorkflowResumePolicy(params.policy) : undefined,
      continuationMessage: stringParam(params.continuationMessage)
    }
    const sessionId = stringParam(params.sessionId)
    const session = sessionId ? this.sessions.maybeGet(sessionId) : undefined

    if (session) {
      const result = await session.controlWorkflowRun(action, target, opts)
      const run = workflowControlResultRun(result) ?? readWorkflowRun(target)
      return { run, control: { mode: 'live', action, result } }
    }

    const run = offlineWorkflowControl(action, target, opts)
    return { run, control: { mode: 'offline_artifact', action } }
  }

  private resolveWorkflowContinuation(
    sessionId: string,
    cwd: string,
    message: string,
    images: unknown[]
  ): { kind: 'none' } | { kind: 'resume'; run: WorkflowRunRecord } | { kind: 'ambiguous'; message: string } {
    if (images.length > 0 || message.trimStart().startsWith('/')) return { kind: 'none' }
    const runs = listRecoverableWorkflowRunsForSession({ cwd, parentSessionId: sessionId }).filter(run =>
      isRecoverableWorkflowStatus(run.status)
    )
    if (runs.length === 0) return { kind: 'none' }
    if (runs.length === 1) return { kind: 'resume', run: runs[0]! }

    const lines = runs
      .slice(0, 8)
      .map(run => `- ${run.id} (${run.status}${run.workflowId ? `, ${run.workflowId}` : ''})`)
    const more = runs.length > lines.length ? `\n- ... ${runs.length - lines.length} more` : ''
    return {
      kind: 'ambiguous',
      message: `Multiple recoverable workflow runs are associated with this session. Choose one explicitly with _pi/workflows/resume before sending a continuation.\n${lines.join('\n')}${more}`
    }
  }

  private parsePiSteerParams(params: Record<string, unknown>): PiSteerParams {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw RequestError.invalidParams({}, 'sessionId must be a non-empty string')
    }

    const prompt = params.prompt
    if (!Array.isArray(prompt)) {
      throw RequestError.invalidParams({}, 'prompt must be an array of ACP content blocks')
    }

    const parsedPrompt = prompt.map((block, index) => {
      const parsed = zContentBlock.safeParse(block)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const path = issue?.path.length ? `.${issue.path.join('.')}` : ''
        const detail = issue ? `: ${issue.message}` : ''
        throw RequestError.invalidParams({}, `prompt[${index}]${path} is not a valid ACP content block${detail}`)
      }
      return parsed.data
    })

    const mode = params.mode ?? 'steer'
    if (mode !== 'steer' && mode !== 'follow_up') {
      throw RequestError.invalidParams({}, 'mode must be "steer" or "follow_up"')
    }

    return { sessionId, prompt: parsedPrompt, mode }
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const pagePlusOne = listPiSessions({
      cwd: effectiveCwd,
      cursor: params.cursor,
      limit: PAGE_SIZE + 1,
      storedSessions: this.store.list()
    })
    const page = pagePlusOne.slice(0, PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = pagePlusOne.length > PAGE_SIZE ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const projectTrustPolicy = this.projectTrustPolicyForRequest(params as { _meta?: unknown })
    const allowProjectLocalReads = this.allowsProjectLocalReads(projectTrustPolicy)
    const fileCommands = loadSlashCommands(params.cwd, { includeProject: allowProjectLocalReads })
    const enableSkillCommands = getEnableSkillCommands(params.cwd, { includeProject: allowProjectLocalReads })
    const activeSession = this.sessions.maybeGet(params.sessionId)

    if (activeSession) {
      const activePolicy = activeSession.projectTrustPolicy ?? 'auto'
      const activeLoadState =
        activePolicy === projectTrustPolicy
          ? await this.getReusableActiveLoadState(activeSession, params)
          : { reusable: false as const }
      if (activeLoadState.reusable) {
        return this.buildLoadSessionResponse(
          activeSession,
          params,
          fileCommands,
          enableSkillCommands,
          activeLoadState.state
        )
      }

      if (activeSession.cwd === params.cwd) {
        this.upsertKnownSessionFile(params.sessionId, params.cwd, activeSession.getSessionFile(), activeSession)
      }
      this.sessions.close(params.sessionId)
    }

    // MVP: ignore mcpServers.
    // Prefer ACP-created mapping first (fast path), otherwise scan pi sessions dir.
    const stored = this.store.get(params.sessionId)
    const storedSessionFile = resolveStoredPiSessionFile(stored, { cwd: params.cwd })
    if (stored && !storedSessionFile) this.store.delete(params.sessionId)
    const sessionFile = storedSessionFile ?? findPiSessionFile(params.sessionId, params.cwd)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    // Spawn pi and point it directly at the session file.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        projectTrustPolicy
      })
    } catch (e: unknown) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      if (e instanceof PiRpcProcessLifecycleError) {
        throw RequestError.internalError({}, e.message)
      }
      throw e
    }

    const loadedState = await proc.getState().catch(() => null)
    const stateSessionId = this.stateString(loadedState, 'sessionId')
    if (stateSessionId && stateSessionId !== params.sessionId) {
      proc.dispose()
      throw RequestError.invalidParams(`Loaded pi session ${stateSessionId} did not match ${params.sessionId}`)
    }

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands,
      sessionFile,
      projectTrustPolicy
    })

    // Policy: within a single ACP connection (one Zed window), keep only one live pi subprocess.
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    if (!this.refreshSessionMapFromPiState(params.sessionId, params.cwd, loadedState, session)) {
      this.store.upsert({
        sessionId: params.sessionId,
        cwd: params.cwd,
        sessionFile
      })
    }

    if (this.replayLoadSessionHistory) {
      const data = (await proc.getMessages()) as any
      const messages = Array.isArray(data?.messages) ? data.messages : []

      for (const m of messages) {
        const role = String(m?.role ?? '')

        if (role === 'user') {
          const text = normalizePiMessageText(m?.content)
          if (text) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text }
              }
            })
          }
        }

        if (role === 'assistant') {
          const text = normalizePiAssistantText(m?.content)
          if (text) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text }
              }
            })
          }
        }

        if (role === 'toolResult') {
          const toolName = String((m as any)?.toolName ?? 'tool')
          const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
          const isError = Boolean((m as any)?.isError)

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: toolName,
              kind: toToolKind(toolName),
              status: 'completed',
              rawInput: null,
              rawOutput: m
            }
          })

          const text = toolResultToText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
              rawOutput: m
            }
          })
        }
      }
    }

    await this.attachRecoverableWorkflowRuns(session, params.cwd, params.sessionId)

    const configOptions = await getSessionConfigOptions(proc)

    const response = {
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    this.scheduleAvailableCommandsUpdate(session.sessionId, proc, fileCommands, enableSkillCommands)

    return response
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId)

    if (params.configId === MODEL_CONFIG_ID) {
      if (typeof params.value !== 'string') {
        throw RequestError.invalidParams('Model config value must be a string')
      }

      const { provider, modelId } = await resolveModelSelection(session.proc, params.value)
      await session.proc.setModel(provider, modelId)
    } else if (params.configId === THINKING_CONFIG_ID) {
      if (typeof params.value !== 'string' || !isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${String(params.value)}`)
      }

      await session.proc.setThinkingLevel(params.value)
    } else {
      throw RequestError.invalidParams(`Unknown configId: ${params.configId}`)
    }

    return {
      configOptions: await getSessionConfigOptions(session.proc)
    }
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    return {}
  }
}

function offlineWorkflowControl(
  action: 'interrupt' | 'pause' | 'resume' | 'abort',
  target: string,
  opts: { reason?: string; policy?: 'continue-existing-session' | 'redo-step' | 'manual'; continuationMessage?: string }
): WorkflowRunRecord {
  switch (action) {
    case 'interrupt':
      return interruptWorkflowRun(target, opts)
    case 'pause':
      return pauseWorkflowRun(target, opts)
    case 'resume':
      return resumeWorkflowRun(target, opts)
    case 'abort':
      return abortWorkflowRun(target, opts)
  }
}

function workflowControlResultRun(value: unknown): WorkflowRunRecord | null {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const run = data?.run && typeof data.run === 'object' ? (data.run as Record<string, unknown>) : data
  if (!run || typeof run.id !== 'string' || typeof run.cwd !== 'string' || typeof run.runDir !== 'string') return null
  return run as WorkflowRunRecord
}

function workflowTargetParam(params: Record<string, unknown>): string {
  const target = stringParam(params.runId) ?? stringParam(params.runDir)
  if (!target) throw RequestError.invalidParams({}, 'runId or runDir must be a non-empty string')
  return target
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function parseWorkflowStatusFilter(value: unknown): WorkflowRunStatus | WorkflowRunStatus[] | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim() as WorkflowRunStatus
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()) as WorkflowRunStatus[]
  return undefined
}

function parseWorkflowResumePolicy(value: unknown): 'continue-existing-session' | 'redo-step' | 'manual' | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'continue-existing-session' || value === 'redo-step' || value === 'manual') return value
  throw RequestError.invalidParams({}, 'policy must be "continue-existing-session", "redo-step", or "manual"')
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
