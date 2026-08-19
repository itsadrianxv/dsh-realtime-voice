import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session/types'

interface SessionStatus {
  sessionId: string
  running: boolean
  blank: boolean
  cwd?: string
  title?: string
  summary?: string
}

interface SessionMatch {
  sessionId: string
  running: boolean
  blank: boolean
  updatedAt: number
  current: boolean
  cwd?: string
  title?: string
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
    const item = (await this.sessions()).find(candidate => candidate.sessionId === this.sessionId)
    if (item === undefined) throw new Error(`DSH session not found: ${this.sessionId}`)
    const summary = await this.lastAssistantText(this.sessionId).catch(() => undefined)
    return {
      sessionId: this.sessionId,
      running: item.running,
      blank: item.blank,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(item.title === undefined ? {} : { title: item.title }),
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
      case 'list_sessions': {
        const query = optionalString(args, 'query')
        const workspace = optionalString(args, 'workspace')
        const limit = optionalInteger(args, 'limit', 1, 10) ?? 5
        const sessions = rankSessions(await this.sessions(), query, workspace).slice(0, limit)
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            count: sessions.length,
            sessions,
            hint: sessions.length === 0
              ? '没有匹配会话；请尝试更短的标题或工作区关键词。'
              : '读取最后回复时，请把准确 sessionId 传给 get_session_latest_reply。',
          }),
        }
      }
      case 'get_session_latest_reply': {
        const targetSessionId = requiredString(args, 'sessionId')
        const session = (await this.sessions()).find(candidate => candidate.sessionId === targetSessionId)
        if (session === undefined) throw new Error(`DSH session not found: ${targetSessionId}`)
        const latestAssistantReply = await this.lastAssistantText(targetSessionId)
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            session,
            latestAssistantReply: latestAssistantReply ?? null,
          }),
        }
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

  private async sessions(): Promise<SessionMatch[]> {
    const response = await this.ctx.apiProxy.sessions.list({ rpcId: this.rpcId(), payload: {} })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value.items.map((item) => {
      const title = projectionTitle(item.projections?.values)
      return {
        sessionId: item.sessionId,
        running: item.running,
        blank: item.blank,
        updatedAt: item.updatedAt,
        current: item.sessionId === this.sessionId,
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        ...(title === undefined ? {} : { title }),
      }
    })
  }

  private async lastAssistantText(sessionId: string): Promise<string | undefined> {
    const response = await this.ctx.apiProxy.sessions.history({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(sessionId), maxMessages: 12 },
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

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key]
  if (result === undefined) return undefined
  if (typeof result !== 'string' || result.trim() === '') throw new Error(`${key} must be a non-empty string`)
  return result.trim()
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const result = value[key]
  if (result === undefined) return undefined
  if (typeof result !== 'number' || !Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`)
  }
  return result
}

function projectionTitle(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const title = (value as Record<string, unknown>).title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (typeof title !== 'object' || title === null) return undefined
  const nested = (title as Record<string, unknown>).title
  return typeof nested === 'string' && nested.trim() !== '' ? nested.trim() : undefined
}

function rankSessions(sessions: SessionMatch[], query?: string, workspace?: string): SessionMatch[] {
  const queryKey = normalizeLookup(query)
  const workspaceKey = normalizeLookup(workspace)
  return sessions
    .map(session => ({ session, score: sessionScore(session, queryKey, workspaceKey) }))
    .filter(candidate => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || right.session.updatedAt - left.session.updatedAt)
    .map(candidate => candidate.session)
}

function sessionScore(session: SessionMatch, query: string | undefined, workspace: string | undefined): number {
  const title = normalizeLookup(session.title) ?? ''
  const cwd = normalizeLookup(session.cwd) ?? ''
  const sessionId = normalizeLookup(session.sessionId) ?? ''
  if (workspace !== undefined && !cwd.includes(workspace)) return -1
  let score = session.current ? 2 : 0
  if (workspace !== undefined) score += 20
  if (query === undefined) return score
  if (title === query) return score + 100
  if (title.includes(query)) return score + 70
  if (cwd.includes(query)) return score + 30
  if (sessionId.includes(query)) return score + 10
  return -1
}

function normalizeLookup(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.trim().toLocaleLowerCase('zh-CN').replaceAll('/', '\\')
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
