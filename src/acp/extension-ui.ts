import type { PiRpcEvent } from '../pi-rpc/process.js'

export function isDialogExtensionUiMethod(method: string): boolean {
  return method === 'select' || method === 'input' || method === 'editor' || method === 'confirm'
}

export function formatExtensionUiRequest(ev: PiRpcEvent): string {
  const method = String((ev as any).method ?? '')
  switch (method) {
    case 'notify': {
      const level = String((ev as any).notifyType ?? 'info')
      const message = typeof (ev as any).message === 'string' ? ((ev as any).message as string) : ''
      return message ? `[${level}] ${message}` : ''
    }
    case 'setStatus': {
      const key = typeof (ev as any).statusKey === 'string' ? ` ${String((ev as any).statusKey)}` : ''
      const statusText = typeof (ev as any).statusText === 'string' ? String((ev as any).statusText) : '(cleared)'
      return `Status${key}: ${statusText}`
    }
    case 'setWidget': {
      const key = typeof (ev as any).widgetKey === 'string' ? ` ${String((ev as any).widgetKey)}` : ''
      const lines = Array.isArray((ev as any).widgetLines)
        ? (ev as any).widgetLines.filter((line: unknown) => typeof line === 'string')
        : []
      return lines.length ? `Widget${key}:\n${lines.join('\n')}` : `Widget${key} updated.`
    }
    case 'setTitle': {
      const title = typeof (ev as any).title === 'string' ? String((ev as any).title) : ''
      return title ? `Title: ${title}` : ''
    }
    case 'set_editor_text':
      return 'Extension requested editor text update.'
    case 'select':
    case 'input':
    case 'editor':
    case 'confirm': {
      const title = typeof (ev as any).title === 'string' ? `: ${String((ev as any).title)}` : ''
      return `Extension UI dialog ${method}${title} is not supported in this ACP adapter and was cancelled.`
    }
    default:
      return method ? `Extension UI request ignored: ${method}` : ''
  }
}
