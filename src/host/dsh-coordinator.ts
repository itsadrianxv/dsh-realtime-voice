import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'

interface SessionState {
  sessionId: string
  running: boolean
  cwd?: string
  title?: string
}

interface WorkerState extends SessionState {
  instruction: string
}

export interface VoiceCoordinatorCallbacks {
  onWorkerStarted?: (worker: Readonly<WorkerState>) => void
  onWorkerUpdated?: (worker: Readonly<WorkerState>) => void
}

export const VOICE_COORDINATOR_PROMPT = `## Realtime voice coordinator

This DSH session is currently the reasoning coordinator for a live voice call. Preserve the session's original instructions, permissions, memory, project context, and ongoing work. The speech provider is only the ears and voice; you are the Agent that decides, answers, and acts.

Keep spoken answers concise and natural. Choose one of three modes:

1. Converse here for discussion, clarification, prioritization, and ordinary questions.
2. Do a quick check here when it is short and immediately helps the live conversation.
3. Delegate blocking mechanics with voice_delegate_task when work is slow, multi-step, or can proceed independently, especially file or app operations, printing, browsing, implementation, deep investigation, log collection, deployment, and device or external-service actions. Keep this coordinator responsive while the worker runs.

For follow-up instructions to a delegated worker, use voice_message_task. Use voice_task_status to inspect it and voice_cancel_task only when the user clearly asks to stop that worker. Worker results will be returned to this coordinator automatically.

Never claim that you cannot access the computer, files, apps, or devices before the appropriate worker has inspected the available DSH tools and permissions. Preserve every concrete constraint in the delegated instruction. For example, a request to find a WeChat document and print it in color, double-sided is blocking mechanics and must be delegated in full, not replaced with manual steps.`

/**
 * Scoped DSH-side coordinator attached only to the Agent session owning one
 * voice call. DSH makes every semantic decision; the audio model gets no tools.
 */
export class DshVoiceCoordinator {
  private readonly workers = new Map<string, WorkerState>()
  private readonly disposers: Array<() => void> = []
  private attached = false

  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string,
    private readonly callbacks: VoiceCoordinatorCallbacks = {},
  ) {}

  async attach(): Promise<void> {
    if (this.attached) return
    // session.models resolves/resumes a cold session through the same official
    // Agent composition path used by WebUI before we add scoped capabilities.
    const models = await this.ctx.apiProxy.sessions.models({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(this.sessionId) },
    })
    if (!models.result.ok) throw new Error(models.result.error.message)
    const agent = this.ctx.agents.get(SessionId(this.sessionId))
    if (agent === undefined) throw new Error(`DSH Agent is unavailable: ${this.sessionId}`)

    this.disposers.push(agent.ctx.systemPrompt.section({
      name: 'realtime-voice:coordinator',
      order: 40,
      text: VOICE_COORDINATOR_PROMPT,
    }))
    this.disposers.push(agent.ctx.tools.register(this.delegateTool()))
    this.disposers.push(agent.ctx.tools.register(this.messageTool()))
    this.disposers.push(agent.ctx.tools.register(this.statusTool()))
    this.disposers.push(agent.ctx.tools.register(this.cancelTool()))
    this.attached = true
  }

  dispose(): void {
    if (!this.attached) return
    this.attached = false
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
  }

  /** Every completed spoken turn enters the authoritative bound DSH session. */
  async submitUserTurn(transcript: string): Promise<void> {
    const state = await this.sessionState(this.sessionId)
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: this.rpcId(),
      payload: {
        sessionId: SessionId(this.sessionId),
        mode: state.running ? 'steer' : 'queue',
        content: [{ type: 'text', text: transcript.trim() }],
      },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
  }

  isWorkerSession(sessionId: string): boolean {
    return this.workers.has(sessionId)
  }

  /** Return one completed worker turn to the coordinator as durable context. */
  async returnWorkerResult(workerSessionId: string, text: string): Promise<void> {
    const worker = this.workers.get(workerSessionId)
    if (worker === undefined) return
    worker.running = false
    this.callbacks.onWorkerUpdated?.(worker)
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: this.rpcId(),
      payload: {
        sessionId: SessionId(this.sessionId),
        mode: 'queue',
        content: [{
          type: 'text',
          text: `[Voice worker returned]\nWorker session: ${workerSessionId}\nOriginal delegated request: ${worker.instruction}\nAuthoritative worker result:\n${text.slice(0, 6_000)}\n\nBriefly report the outcome in the live voice conversation. If a user decision is needed, ask exactly that question. Do not repeat or redo completed work.`,
        }],
      },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
  }

  private delegateTool() {
    return defineTool({
      name: 'voice_delegate_task',
      description: 'Create a real background DSH Agent session for slow, multi-step, blocking, or independent work while this live voice coordinator remains responsive.',
      parameters: {
        instruction: { type: 'string', required: true, description: 'Complete worker instruction preserving every user constraint.' },
        title: { type: 'string', description: 'Short task title shown in DSH.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => this.delegate(args.instruction, args.title),
    })
  }

  private messageTool() {
    return defineTool({
      name: 'voice_message_task',
      description: 'Send a follow-up or correction to a background DSH worker created by this voice call.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Worker session id returned by voice_delegate_task.' },
        instruction: { type: 'string', required: true, description: 'Complete follow-up instruction.' },
        mode: { type: 'string', enum: ['auto', 'queue', 'steer'], description: 'auto steers a running worker and queues an idle worker.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            mode: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => this.messageWorker(args.sessionId, args.instruction, args.mode ?? 'auto'),
    })
  }

  private statusTool() {
    return defineTool({
      name: 'voice_task_status',
      description: 'Read the authoritative running state and latest reply of a background worker created by this voice call.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Worker session id returned by voice_delegate_task.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', required: true },
            running: { type: 'boolean', required: true },
            title: { type: 'string', required: true },
            latestReply: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => this.workerStatus(args.sessionId),
    })
  }

  private cancelTool() {
    return defineTool({
      name: 'voice_cancel_task',
      description: 'Cancel one background worker only after the user clearly asks to stop that delegated task.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Worker session id returned by voice_delegate_task.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => this.cancelWorker(args.sessionId),
    })
  }

  private async delegate(instruction: string, requestedTitle: string | undefined) {
    const parent = await this.sessionState(this.sessionId)
    const created = await this.ctx.apiProxy.sessions.create({
      rpcId: this.rpcId(),
      payload: parent.cwd === undefined ? {} : { cwd: parent.cwd },
    })
    if (!created.result.ok) throw new Error(created.result.error.message)
    const workerSessionId = created.result.value.sessionId
    const title = requestedTitle?.trim() || instruction.trim().slice(0, 48) || 'Voice delegated task'

    const models = await this.ctx.apiProxy.sessions.models({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(this.sessionId) },
    })
    if (models.result.ok) {
      const current = models.result.value.current
      const selected = await this.ctx.apiProxy.sessions.selectModel({
        rpcId: this.rpcId(),
        payload: {
          sessionId: SessionId(workerSessionId),
          provider: current.provider,
          model: current.model,
          ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
        },
      })
      if (!selected.result.ok) throw new Error(selected.result.error.message)
    }

    const renamed = await this.ctx.apiProxy.sessions.rename({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(workerSessionId), title },
    })
    if (!renamed.result.ok) throw new Error(renamed.result.error.message)

    const worker: WorkerState = {
      sessionId: workerSessionId,
      running: true,
      ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
      title: renamed.result.value.title,
      instruction: instruction.trim(),
    }
    this.workers.set(workerSessionId, worker)
    this.callbacks.onWorkerStarted?.(worker)
    const prompted = await this.ctx.apiProxy.sessions.prompt({
      rpcId: this.rpcId(),
      payload: {
        sessionId: SessionId(workerSessionId),
        mode: 'queue',
        content: [{ type: 'text', text: instruction.trim() }],
      },
    })
    if (!prompted.result.ok) throw new Error(prompted.result.error.message)
    return { sessionId: workerSessionId, status: 'running', title: worker.title ?? title }
  }

  private async messageWorker(sessionId: string, instruction: string, requestedMode: 'auto' | 'queue' | 'steer') {
    const worker = this.requireWorker(sessionId)
    const state = await this.sessionState(sessionId)
    const mode = requestedMode === 'auto' ? state.running ? 'steer' : 'queue' : requestedMode
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: this.rpcId(),
      payload: {
        sessionId: SessionId(sessionId),
        mode,
        content: [{ type: 'text', text: instruction.trim() }],
      },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    worker.running = true
    this.callbacks.onWorkerUpdated?.(worker)
    return { sessionId, status: 'accepted', mode }
  }

  private async workerStatus(sessionId: string) {
    const worker = this.requireWorker(sessionId)
    const state = await this.sessionState(sessionId)
    const latestReply = await this.lastAssistantText(sessionId)
    worker.running = state.running
    this.callbacks.onWorkerUpdated?.(worker)
    return {
      sessionId,
      running: state.running,
      title: state.title ?? worker.title ?? '',
      latestReply: latestReply ?? '',
    }
  }

  private async cancelWorker(sessionId: string) {
    const worker = this.requireWorker(sessionId)
    const response = await this.ctx.apiProxy.sessions.cancel({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(sessionId) },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    worker.running = false
    this.callbacks.onWorkerUpdated?.(worker)
    return { sessionId, status: 'cancelled' }
  }

  private requireWorker(sessionId: string): WorkerState {
    const worker = this.workers.get(sessionId)
    if (worker === undefined) throw new Error(`voice worker is not owned by this call: ${sessionId}`)
    return worker
  }

  private async sessionState(sessionId: string): Promise<SessionState> {
    const response = await this.ctx.apiProxy.sessions.list({ rpcId: this.rpcId(), payload: {} })
    if (!response.result.ok) throw new Error(response.result.error.message)
    const item = response.result.value.items.find(candidate => candidate.sessionId === sessionId)
    if (item === undefined) throw new Error(`DSH session not found: ${sessionId}`)
    const title = projectionTitle(item.projections?.values)
    return {
      sessionId,
      running: item.running,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(title === undefined ? {} : { title }),
    }
  }

  private async lastAssistantText(sessionId: string): Promise<string | undefined> {
    const response = await this.ctx.apiProxy.sessions.history({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(sessionId), maxMessages: 12 },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    for (let index = response.result.value.events.length - 1; index >= 0; index -= 1) {
      const event = response.result.value.events[index]?.event as unknown
      if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'assistant/message') continue
      const data = (event as { data?: unknown }).data
      if (typeof data !== 'object' || data === null) continue
      const message = (data as { message?: unknown }).message
      if (typeof message !== 'object' || message === null) continue
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      const text = content.map(block => typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text : '').filter(Boolean).join('\n').trim()
      if (text !== '') return text.slice(0, 2_000)
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
