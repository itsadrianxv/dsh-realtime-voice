import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session/types'

interface SessionStatus {
  sessionId: string
  running: boolean
  blank: boolean
  cwd?: string
  summary?: string
}
export interface VoiceToolCall {
  callId: string
  name: string
  arguments: string
}

export interface VoiceToolResult {
  ok: boolean
  output: string
}

/** Allowlisted translation from realtime-model Function Calls to official DSH API services. */
export class DshVoiceTools {
  private readonly completed = new Map<string, Promise<VoiceToolResult>>()

  constructor(private readonly ctx: Context, private readonly sessionId: string) {}

  /** Execute one idempotent allowlisted call. Duplicate call ids share the first result. */
  execute(call: VoiceToolCall): Promise<VoiceToolResult> {
    const existing = this.completed.get(call.callId)
    if (existing !== undefined) return existing
    const operation = this.executeOnce(call).catch((error: unknown) => ({
      ok: false,
      output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    }))
    this.completed.set(call.callId, operation)
    return operation
  }

  /** Read the current DSH status used both by UI and initial voice context. */
  async status(): Promise<SessionStatus> {
    const list = await this.ctx.apiProxy.sessions.list({ rpcId: this.rpcId(), payload: {} })
    if (!list.result.ok) throw new Error(list.result.error.message)
    const item = list.result.value.items.find(candidate => candidate.sessionId === this.sessionId)
    if (item === undefined) throw new Error(`DSH session not found: ${this.sessionId}`)
    const summary = await this.lastAssistantText().catch(() => undefined)
    return {
      sessionId: this.sessionId,
      running: item.running,
      blank: item.blank,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(summary === undefined ? {} : { summary }),
    }
  }

  private async executeOnce(call: VoiceToolCall): Promise<VoiceToolResult> {
    const args = parseObject(call.arguments)
    switch (call.name) {
      case 'start_task': {
        const instruction = requiredString(args, 'instruction')
        return this.prompt(instruction, 'queue')
      }
      case 'send_task_message': {
        const instruction = requiredString(args, 'instruction')
        const requestedMode = args.mode
        if (requestedMode !== undefined && requestedMode !== 'auto' && requestedMode !== 'queue' && requestedMode !== 'steer') {
          throw new Error('mode must be auto, queue, or steer')
        }
        const mode = requestedMode === undefined || requestedMode === 'auto'
          ? (await this.status()).running ? 'steer' : 'queue'
          : requestedMode
        return this.prompt(instruction, mode)
      }
      case 'get_task_status': {
        return { ok: true, output: JSON.stringify({ ok: true, ...(await this.status()) }) }
      }
      case 'cancel_task': {
        const response = await this.ctx.apiProxy.sessions.cancel({
          rpcId: this.rpcId(),
          payload: { sessionId: SessionId(this.sessionId) },
        })
        if (!response.result.ok) throw new Error(response.result.error.message)
        return { ok: true, output: JSON.stringify({ ok: true, accepted: true }) }
      }
      default:
        throw new Error(`voice tool is not allowed: ${call.name}`)
    }
  }

  private async prompt(instruction: string, mode: 'queue' | 'steer'): Promise<VoiceToolResult> {
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: this.rpcId(),
      payload: {
        sessionId: SessionId(this.sessionId),
        mode,
        content: [{ type: 'text', text: instruction }],
      },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { ok: true, output: JSON.stringify({ ok: true, accepted: true, mode }) }
  }

  private async lastAssistantText(): Promise<string | undefined> {
    const response = await this.ctx.apiProxy.sessions.history({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(this.sessionId), maxMessages: 12 },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    for (let index = response.result.value.events.length - 1; index >= 0; index -= 1) {
      const event = response.result.value.events[index]?.event as unknown
      const text = assistantText(event)
      if (text !== undefined) return text.slice(0, 1200)
    }
    return undefined
  }

  private rpcId() {
    return RpcId(randomUUID())
  }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('function arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== 'string' || result.trim() === '') throw new Error(`${key} must be a non-empty string`)
  return result.trim()
}

function assistantText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const event = value as Record<string, unknown>
  if (event.type !== 'assistant/message') return undefined
  const message = event.message as Record<string, unknown> | undefined
  if (!Array.isArray(message?.content)) return undefined
  const text = message.content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const entry = block as Record<string, unknown>
      return entry.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}
