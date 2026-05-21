import type { PiRpcEvent } from '../pi-rpc/process.js'
import { stripAnsi } from '../shared/ansi.js'

export const PI_EXTENSION_UI_EVENT_METHOD = '_pi/extension_ui_event'

type ExtensionUiPayload = Record<string, unknown>

export function isDialogExtensionUiMethod(method: string): boolean {
  return method === 'select' || method === 'input' || method === 'editor' || method === 'confirm'
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' ? stripAnsi(value) : undefined
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(stripAnsi) : []
}

function addString(target: ExtensionUiPayload, key: string, value: unknown): void {
  const cleaned = cleanString(value)
  if (cleaned !== undefined) target[key] = cleaned
}

export function normalizeExtensionUiRequest(sessionId: string, ev: PiRpcEvent): ExtensionUiPayload | null {
  const method = String((ev as any).method ?? '')
  if (!method) return null

  const id = cleanString((ev as any).id)
  const payload: ExtensionUiPayload = { sessionId, method }
  if (id) payload.id = id

  switch (method) {
    case 'notify':
      payload.event = 'notify'
      addString(payload, 'notifyType', (ev as any).notifyType)
      addString(payload, 'level', (ev as any).notifyType)
      addString(payload, 'message', (ev as any).message)
      return payload

    case 'setStatus':
      payload.event = 'status'
      addString(payload, 'statusKey', (ev as any).statusKey)
      addString(payload, 'statusText', (ev as any).statusText)
      if (!('statusText' in payload)) payload.cleared = true
      return payload

    case 'setWidget':
      payload.event = 'widget'
      addString(payload, 'widgetKey', (ev as any).widgetKey)
      addString(payload, 'widgetPlacement', (ev as any).widgetPlacement)
      if (Array.isArray((ev as any).widgetLines)) {
        payload.widgetLines = cleanStringArray((ev as any).widgetLines)
      } else {
        payload.cleared = true
      }
      return payload

    case 'setTitle':
      payload.event = 'title'
      addString(payload, 'title', (ev as any).title)
      return payload

    case 'set_editor_text': {
      payload.event = 'editor_text'
      const text = cleanString((ev as any).text)
      payload.hasText = text !== undefined
      if (text !== undefined) payload.textLength = text.length
      return payload
    }

    case 'select':
    case 'input':
    case 'editor':
    case 'confirm':
      payload.event = 'dialog_cancelled'
      payload.dialogType = method
      payload.cancelled = true
      addString(payload, 'title', (ev as any).title)
      addString(payload, 'message', (ev as any).message)
      addString(payload, 'placeholder', (ev as any).placeholder)
      if (Array.isArray((ev as any).options)) payload.optionCount = (ev as any).options.length
      return payload

    default:
      payload.event = 'ignored'
      return payload
  }
}
