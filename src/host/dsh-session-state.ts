import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
const SessionId = (value: string): any => value
const RpcId = (value: string): any => value

export interface VoiceSessionSnapshot {
  sessionId: string
  running: boolean
  blank: boolean
  cwd?: string
  title?: string
  summary?: string
}

/** Read-only state used to bind the audio transport to one authoritative DSH Agent. */
export class DshVoiceSession {
  constructor(private readonly ctx: Context, private readonly sessionId: string) {}

  async snapshot(): Promise<VoiceSessionSnapshot> {
    const response = await this.ctx.apiProxy.sessions.list({ rpcId: this.rpcId(), payload: {} })
    if (!response.result.ok) throw new Error(response.result.error.message)
    const item = response.result.value.items.find(candidate => candidate.sessionId === this.sessionId)
    if (item === undefined) throw new Error(`DSH session not found: ${this.sessionId}`)
    const title = projectionTitle(item.projections?.values)
    const summary = await this.lastAssistantText().catch(() => undefined)
    return {
      sessionId: this.sessionId,
      running: item.running,
      blank: item.blank,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
    }
  }

  private async lastAssistantText(): Promise<string | undefined> {
    const response = await this.ctx.apiProxy.sessions.history({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(this.sessionId), maxMessages: 12 },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    for (let index = response.result.value.events.length - 1; index >= 0; index -= 1) {
      const text = assistantText(response.result.value.events[index]?.event)
      if (text !== undefined) return text.slice(0, 1_200)
    }
    return undefined
  }

  private rpcId() {
    return RpcId(randomUUID())
  }
}

function projectionTitle(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const title = (value as Record<string, unknown>).title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (typeof title !== 'object' || title === null) return undefined
  const nested = (title as Record<string, unknown>).title
  return typeof nested === 'string' && nested.trim() !== '' ? nested.trim() : undefined
}

export function assistantText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const event = value as Record<string, unknown>
  if (event.type !== 'assistant/message') return undefined
  const data = event.data as Record<string, unknown> | undefined
  // rc.7 persists the message under event.data.message. Keep the direct fallback
  // for older fixtures and pre-release DSH builds.
  const message = (data?.message ?? event.message) as Record<string, unknown> | undefined
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
