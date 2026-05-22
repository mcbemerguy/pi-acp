import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../pi-rpc/process.js'
import { stripAnsi } from '../shared/ansi.js'

export const PI_EXTENSION_UI_EVENT_METHOD = '_pi/extension_ui_event'
const ASK_QUESTION_METHOD = 'cursor/ask_question'
const SELECTION_QUESTION_ID = 'selection'
const INPUT_QUESTION_ID = 'value'
const CONFIRM_QUESTION_ID = 'confirmed'

type ExtensionUiResponder = {
  sendExtensionUiResponse(id: string, payload: Record<string, unknown>): Promise<void> | void
}

type AskQuestionOption = {
  id: string
  label: string
}

type AskQuestionPayload = {
  toolCallId: string
  title: string
  questions: Array<{
    id: string
    prompt: string
    options?: AskQuestionOption[]
    allowMultiple?: boolean
  }>
}

type DialogRequest = {
  id: string
  method: string
  title: string
  prompt: string
  options: string[]
  placeholder?: string
}

type ExtensionUiPayload = Record<string, unknown>

export function isDialogExtensionUiMethod(method: string): boolean {
  return method === 'select' || method === 'input' || method === 'editor' || method === 'confirm'
}

export async function handleExtensionUiRequest(params: {
  event: PiRpcEvent
  conn: AgentSideConnection
  proc: ExtensionUiResponder
}): Promise<void> {
  const request = parseDialogRequest(params.event)
  if (!request) {
    const id = coerceId((params.event as { id?: unknown }).id)
    if (id) await params.proc.sendExtensionUiResponse(id, { cancelled: true })
    return
  }

  try {
    switch (request.method) {
      case 'select':
        await handleSelect(params.conn, params.proc, request)
        return
      case 'input':
        await handleInput(params.conn, params.proc, request)
        return
      case 'confirm':
        await handleConfirm(params.conn, params.proc, request)
        return
      case 'editor':
        await handleEditor(params.conn, params.proc, request, params.event)
        return
      default:
        await sendCancellation(params.proc, request)
        return
    }
  } catch {
    await sendCancellation(params.proc, request)
  }
}

export function normalizeExtensionUiRequest(sessionId: string, ev: PiRpcEvent): ExtensionUiPayload | null {
  const method = String((ev as { method?: unknown }).method ?? '')
  if (!method) return null

  const id = cleanString((ev as { id?: unknown }).id)
  const payload: ExtensionUiPayload = { sessionId, method }
  if (id) payload.id = id

  switch (method) {
    case 'notify':
      payload.event = 'notify'
      addString(payload, 'notifyType', (ev as { notifyType?: unknown }).notifyType)
      addString(payload, 'level', (ev as { notifyType?: unknown }).notifyType)
      addString(payload, 'message', (ev as { message?: unknown }).message)
      return payload

    case 'setStatus':
      payload.event = 'status'
      addString(payload, 'statusKey', (ev as { statusKey?: unknown }).statusKey)
      addString(payload, 'statusText', (ev as { statusText?: unknown }).statusText)
      if (!('statusText' in payload)) payload.cleared = true
      return payload

    case 'setWidget':
      payload.event = 'widget'
      addString(payload, 'widgetKey', (ev as { widgetKey?: unknown }).widgetKey)
      addString(payload, 'widgetPlacement', (ev as { widgetPlacement?: unknown }).widgetPlacement)
      if (Array.isArray((ev as { widgetLines?: unknown }).widgetLines)) {
        payload.widgetLines = cleanStringArray((ev as { widgetLines?: unknown }).widgetLines)
      } else {
        payload.cleared = true
      }
      return payload

    case 'setTitle':
      payload.event = 'title'
      addString(payload, 'title', (ev as { title?: unknown }).title)
      return payload

    case 'set_editor_text': {
      payload.event = 'editor_text'
      const text = cleanString((ev as { text?: unknown }).text)
      payload.hasText = text !== undefined
      if (text !== undefined) payload.textLength = text.length
      return payload
    }

    case 'select':
    case 'input':
    case 'editor':
    case 'confirm':
      payload.event = 'dialog'
      payload.dialogType = method
      addString(payload, 'title', (ev as { title?: unknown }).title)
      addString(payload, 'message', (ev as { message?: unknown }).message)
      addString(payload, 'placeholder', (ev as { placeholder?: unknown }).placeholder)
      if (Array.isArray((ev as { options?: unknown }).options))
        payload.optionCount = (ev as { options: unknown[] }).options.length
      return payload

    default:
      payload.event = 'ignored'
      return payload
  }
}

function parseDialogRequest(event: PiRpcEvent): DialogRequest | null {
  const id = coerceId((event as { id?: unknown }).id)
  if (!id) return null

  const method = asNonEmptyString((event as { method?: unknown }).method)
  if (!method) return null

  const title =
    asString((event as { title?: unknown }).title) ??
    asString((event as { message?: unknown }).message) ??
    asString((event as { prompt?: unknown }).prompt) ??
    method

  const prompt = asString((event as { message?: unknown }).message) ?? title
  const options = toOptionLabels((event as { options?: unknown }).options)
  const placeholder = asString((event as { placeholder?: unknown }).placeholder)

  return { id, method, title, prompt, options, placeholder: placeholder ?? undefined }
}

async function handleSelect(
  conn: AgentSideConnection,
  proc: ExtensionUiResponder,
  request: DialogRequest
): Promise<void> {
  if (request.options.length === 0) {
    await sendCancellation(proc, request)
    return
  }

  const options = request.options.map((label, index) => ({ id: String(index), label }))
  const response = await conn.extMethod(ASK_QUESTION_METHOD, {
    toolCallId: request.id,
    title: request.title,
    questions: [
      {
        id: SELECTION_QUESTION_ID,
        prompt: request.prompt,
        options,
        allowMultiple: false
      }
    ]
  } satisfies AskQuestionPayload)

  const value = normalizeSelectionAnswer(response, SELECTION_QUESTION_ID, options)
  if (!value) {
    await sendCancellation(proc, request)
    return
  }

  await proc.sendExtensionUiResponse(request.id, { value })
}

async function handleInput(
  conn: AgentSideConnection,
  proc: ExtensionUiResponder,
  request: DialogRequest
): Promise<void> {
  const response = await conn.extMethod(ASK_QUESTION_METHOD, {
    toolCallId: request.id,
    title: request.title,
    questions: [
      {
        id: INPUT_QUESTION_ID,
        prompt: request.placeholder ? `${request.prompt}\n${request.placeholder}` : request.prompt,
        allowMultiple: false
      }
    ]
  } satisfies AskQuestionPayload)

  const value = normalizeTextAnswer(response, INPUT_QUESTION_ID)
  if (!value) {
    await sendCancellation(proc, request)
    return
  }

  await proc.sendExtensionUiResponse(request.id, { value })
}

async function handleConfirm(
  conn: AgentSideConnection,
  proc: ExtensionUiResponder,
  request: DialogRequest
): Promise<void> {
  const options = [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' }
  ]
  const response = await conn.extMethod(ASK_QUESTION_METHOD, {
    toolCallId: request.id,
    title: request.title,
    questions: [
      {
        id: CONFIRM_QUESTION_ID,
        prompt: request.prompt,
        options,
        allowMultiple: false
      }
    ]
  } satisfies AskQuestionPayload)

  const raw = extractAnswer(response, CONFIRM_QUESTION_ID)
  const confirmed = normalizeConfirmAnswer(raw)
  await proc.sendExtensionUiResponse(request.id, { confirmed: confirmed === true })
}

async function handleEditor(
  conn: AgentSideConnection,
  proc: ExtensionUiResponder,
  request: DialogRequest,
  event: PiRpcEvent
): Promise<void> {
  const existingText =
    asString((event as { prefill?: unknown }).prefill) ??
    asString((event as { text?: unknown }).text) ??
    asString((event as { value?: unknown }).value)
  const prompt = existingText ? `${request.prompt}\n\n${existingText}` : request.prompt
  const response = await conn.extMethod(ASK_QUESTION_METHOD, {
    toolCallId: request.id,
    title: request.title,
    questions: [
      {
        id: INPUT_QUESTION_ID,
        prompt,
        allowMultiple: false
      }
    ]
  } satisfies AskQuestionPayload)

  const value = normalizeTextAnswer(response, INPUT_QUESTION_ID)
  if (!value) {
    await sendCancellation(proc, request)
    return
  }

  await proc.sendExtensionUiResponse(request.id, { value })
}

async function sendCancellation(proc: ExtensionUiResponder, request: DialogRequest): Promise<void> {
  const payload = request.method === 'confirm' ? { confirmed: false } : { cancelled: true }
  await proc.sendExtensionUiResponse(request.id, payload)
}

function normalizeSelectionAnswer(
  response: Record<string, unknown>,
  questionId: string,
  options: AskQuestionOption[]
): string | null {
  const value = extractAnswer(response, questionId)
  const text = normalizeAnswerToString(value)
  if (!text) return null

  const byId = options.find(option => option.id === text)
  if (byId) return byId.label

  const byLabel = options.find(option => option.label === text)
  if (byLabel) return byLabel.label

  return text
}

function normalizeTextAnswer(response: Record<string, unknown>, questionId: string): string | null {
  return normalizeAnswerToString(extractAnswer(response, questionId))
}

function normalizeConfirmAnswer(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value

  const text = normalizeAnswerToString(value)
  if (!text) return null

  const normalized = text.trim().toLowerCase()
  if (['yes', 'y', 'true', '1', 'confirmed'].includes(normalized)) return true
  if (['no', 'n', 'false', '0', 'cancelled', 'canceled', 'deny', 'denied'].includes(normalized)) return false
  return null
}

function extractAnswer(response: Record<string, unknown>, questionId: string): unknown {
  const answers = response.answers
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    const answerMap = answers as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(answerMap, questionId)) return answerMap[questionId]
    const firstKey = Object.keys(answerMap)[0]
    if (firstKey) return answerMap[firstKey]
  }

  if (Object.prototype.hasOwnProperty.call(response, 'value')) return response.value
  if (Object.prototype.hasOwnProperty.call(response, 'answer')) return response.answer

  return undefined
}

function normalizeAnswerToString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeAnswerToString(item)
      if (text) return text
    }
    return null
  }

  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return (
      normalizeAnswerToString(object.label) ??
      normalizeAnswerToString(object.value) ??
      normalizeAnswerToString(object.id)
    )
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  return null
}

function toOptionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return []

  const labels: string[] = []
  for (const option of options) {
    const label =
      typeof option === 'string'
        ? option
        : option && typeof option === 'object'
          ? (asString((option as { label?: unknown }).label) ?? asString((option as { value?: unknown }).value))
          : null

    if (label !== null && label.trim()) labels.push(label)
  }

  return labels
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

function coerceId(id: unknown): string | null {
  if (typeof id === 'string' && id.trim()) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return null
}

function asNonEmptyString(value: unknown): string | null {
  const text = asString(value)
  return text && text.trim() ? text : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
