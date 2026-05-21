import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]
type ExtNotificationMsg = { method: string; params: Record<string, unknown> }

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly extNotifications: ExtNotificationMsg[] = []
  readonly sent: Array<
    { type: 'sessionUpdate'; msg: SessionUpdateMsg } | { type: 'extNotification'; msg: ExtNotificationMsg }
  > = []
  extNotificationDelayMs = 0
  extNotificationBlocker: Promise<void> | null = null

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
    this.sent.push({ type: 'sessionUpdate', msg })
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.extNotificationBlocker) await this.extNotificationBlocker
    if (this.extNotificationDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.extNotificationDelayMs))
    const msg = { method, params }
    this.extNotifications.push(msg)
    this.sent.push({ type: 'extNotification', msg })
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: Array<{
    id: string
    response: { cancelled?: boolean; value?: unknown; confirmed?: boolean }
  }> = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  respondExtensionUi(
    id: string,
    response: { cancelled?: boolean; value?: unknown; confirmed?: boolean } = { cancelled: true }
  ): void {
    this.extensionUiResponses.push({ id, response })
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
