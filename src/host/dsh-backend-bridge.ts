import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { DirectBackendEventKind } from '../direct-protocol.ts'

const RpcId = (value: string): any => value
import {
  DshVoiceCoordinator,
  type PendingVoiceApproval,
  type PendingVoiceQuestion,
} from './dsh-coordinator.ts'
import { assistantText, DshVoiceSession } from './dsh-session-state.ts'

export interface DshBackendEvent {
  eventId: string
  kind: DirectBackendEventKind
  text: string
}

export interface DshBackendBridgeCallbacks {
  onAgentStatus: (status: { sessionId: string; running: boolean; summary?: string }) => void
  onApproval: (approval: PendingVoiceApproval, status: 'pending' | 'resolved', outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => void
  onQuestion: (question: PendingVoiceQuestion, status: 'pending' | 'resolved', outcome?: 'answered' | 'cancelled') => void
  onBackendEvent: (event: DshBackendEvent) => void
}

/** Continuity-scoped projection of authoritative DSH events into voice semantics. */
export class DshBackendBridge {
  private callbacks: DshBackendBridgeCallbacks
  private readonly abort = new AbortController()
  private readonly pendingAssistantByTurn = new Map<number, string>()
  private dshTurnRunning = false
  private activeDshJobs = 0
  private started = false
  private readonly retryTimers = new Map<'host' | 'mux', ReturnType<typeof setTimeout>>()

  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string,
    readonly coordinator: DshVoiceCoordinator,
    callbacks: DshBackendBridgeCallbacks,
  ) {
    this.callbacks = callbacks
  }

  setCallbacks(callbacks: DshBackendBridgeCallbacks): void {
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.followHostEvents()
    this.followMuxEvents()
    await this.reconcileHistory()
  }

  emitCurrentStatus(): void {
    this.emitAgentStatus()
  }

  stop(): void {
    this.abort.abort()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  snapshotPendingInteractions(): void {
    for (const approval of this.coordinator.listPendingApprovals()) this.callbacks.onApproval(approval, 'pending')
    for (const question of this.coordinator.listPendingQuestions()) this.callbacks.onQuestion(question, 'pending')
  }

  private followHostEvents(): void {
    const request = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.host(request, this.abort.signal)) {
        const frame = item.payload
        if (frame.type === 'host/session-status' && frame.sessionId === this.sessionId) {
          this.dshTurnRunning = frame.running
          this.emitAgentStatus()
          continue
        }
        if (frame.type !== 'host/agent-error' || frame.sessionId !== this.sessionId) continue
        this.coordinator.markFailed()
        this.dshTurnRunning = false
        this.activeDshJobs = 0
        this.emitAgentStatus('DSH Agent 运行失败。')
        this.callbacks.onBackendEvent({
          eventId: `dsh:${this.sessionId}:agent-error:${randomUUID()}`,
          kind: 'failed',
          text: '[BACKEND][FAILED] DSH Agent 运行失败。请如实告诉用户任务没有完成，并建议查看绑定任务中的错误详情。',
        })
      }
    })().catch((error: unknown) => {
      if (!this.abort.signal.aborted) this.ctx.logger.warn(error)
    }).finally(() => this.scheduleRetry('host'))
  }

  private followMuxEvents(): void {
    const request = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.mux(request, this.abort.signal)) {
        const frame = item.payload
        if (!('sessionId' in frame) || frame.sessionId !== this.sessionId) continue
        if (frame.type === 'approval/requested') {
          const approval: PendingVoiceApproval = {
            rpcId: item.rpcId,
            approvalId: frame.approvalId,
            sessionId: frame.sessionId,
            toolName: frame.toolName,
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            ...(frame.reason === undefined ? {} : { reason: frame.reason }),
          }
          this.coordinator.rememberApproval(approval)
          this.callbacks.onApproval(approval, 'pending')
          this.callbacks.onBackendEvent({
            eventId: `dsh:${this.sessionId}:approval:${frame.approvalId}:requested`,
            kind: 'needs-approval',
            text: `[BACKEND][NEEDS_APPROVAL] approval_id=${frame.approvalId}；工具=${frame.toolName}；原因=${frame.reason ?? '未提供'}。请简短说明风险并询问用户，随后调用 answer_dsh_approval。`,
          })
          continue
        }
        if (frame.type === 'approval/resolved') {
          const existing = this.coordinator.listPendingApprovals().find(value => value.approvalId === frame.approvalId)
          this.coordinator.forgetApproval(frame.approvalId)
          if (existing !== undefined) this.callbacks.onApproval(existing, 'resolved', frame.outcome)
          continue
        }
        if (frame.type === 'question/requested') {
          const question: PendingVoiceQuestion = {
            rpcId: item.rpcId,
            sessionId: frame.sessionId,
            questions: frame.questions.map(value => ({
              id: value.id,
              question: value.question,
              ...(value.detail === undefined ? {} : { detail: value.detail }),
              ...(value.header === undefined ? {} : { header: value.header }),
              ...(value.options === undefined ? {} : { options: value.options.map(option => ({ ...option })) }),
              ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
            })),
          }
          this.coordinator.rememberQuestion(question)
          this.callbacks.onQuestion(question, 'pending')
          this.callbacks.onBackendEvent({
            eventId: `dsh:${this.sessionId}:question:${item.rpcId}:requested`,
            kind: 'needs-input',
            text: `[BACKEND][NEEDS_INPUT] request_id=${item.rpcId}。问题：${formatQuestions(question)}。请自然询问用户，随后调用 answer_dsh_question。`,
          })
          continue
        }
        if (frame.type === 'question/resolved') {
          const existing = this.coordinator.listPendingQuestions().find(value => value.rpcId === frame.questionRpcId)
          this.coordinator.forgetQuestion(frame.questionRpcId)
          if (existing !== undefined) this.callbacks.onQuestion(existing, 'resolved', frame.outcome)
          continue
        }
        if (frame.type === 'session/queue') {
          this.coordinator.observeQueue(frame.items)
          continue
        }
        if (frame.type === 'session/jobs') {
          const active = frame.jobs.filter(job => job.status === 'running' || job.status === 'stopping')
          this.activeDshJobs = active.length
          this.emitAgentStatus(active.length === 0 ? undefined : active.map(job => job.label).join('、').slice(0, 1_200))
          continue
        }
        if (frame.type !== 'session/event') continue
        this.projectSessionEvent(frame.event)
      }
    })().catch((error: unknown) => {
      if (!this.abort.signal.aborted) this.ctx.logger.warn(error)
    }).finally(() => this.scheduleRetry('mux'))
  }

  private projectSessionEvent(event: Record<string, unknown>): void {
    const data = event.data as Record<string, unknown> | undefined
    if (event.type === 'user/message') {
      const rpcId = messageSourceRpcId(data)
      if (rpcId !== undefined) this.coordinator.observeUserMessage(rpcId)
      return
    }
    if (event.type === 'turn/start') {
      if (typeof data?.turn === 'number') this.coordinator.markTurnStarted(data.turn)
      this.dshTurnRunning = true
      this.emitAgentStatus()
      return
    }
    if (event.type === 'assistant/message') {
      const turn = data?.turn
      const text = assistantText(event)
      if (typeof turn === 'number' && text !== undefined) {
        this.coordinator.observeTurnEvent(turn)
        this.pendingAssistantByTurn.set(turn, text)
        this.emitAgentStatus(text.slice(0, 1_200))
        this.callbacks.onBackendEvent({
          eventId: `dsh:${this.sessionId}:event:${String(event.seq ?? turn)}:status`,
          kind: 'status',
          text: `[BACKEND][STATUS] ${text}\n这是执行中的阶段更新，不是最终完成。`,
        })
      }
      return
    }
    if (event.type !== 'turn/end' || typeof data?.turn !== 'number') {
      if (typeof data?.turn === 'number') this.coordinator.observeTurnEvent(data.turn)
      return
    }
    const reason = turnEndKind(data.reason)
    const text = this.pendingAssistantByTurn.get(data.turn)
    this.pendingAssistantByTurn.delete(data.turn)
    this.coordinator.markTurnEnded(data.turn, reason)
    this.dshTurnRunning = false
    this.emitAgentStatus(text?.slice(0, 1_200))
    const kind = reason === 'completed' ? 'complete' : reason
    const tag = reason === 'completed' ? 'COMPLETE' : reason === 'cancelled' ? 'CANCELLED' : 'FAILED'
    this.callbacks.onBackendEvent({
      eventId: `dsh:${this.sessionId}:event:${String(event.seq ?? data.turn)}:terminal:${reason}`,
      kind,
      text: `[BACKEND][${tag}] ${text ?? `DSH Agent 已结束本轮工作，结束状态为 ${reason}。`}\n这是绑定任务的权威终态。`,
    })
  }

  private async reconcileHistory(): Promise<void> {
    try {
      // Existing durable history is context, not a stream of new voice events.
      // Replaying it would announce old completed turns on the first direct call.
      const current = await new DshVoiceSession(this.ctx, this.sessionId).snapshot()
      this.dshTurnRunning = current.running
      this.emitAgentStatus(current.summary)
    } catch (error) {
      this.ctx.logger.warn(`[realtime-voice] failed to reconcile direct DSH history: ${String(error)}`)
    }
  }

  private emitAgentStatus(summary?: string): void {
    this.callbacks.onAgentStatus({
      sessionId: this.sessionId,
      running: this.dshTurnRunning || this.activeDshJobs > 0 || this.coordinator.active,
      ...(summary === undefined ? {} : { summary }),
    })
  }

  private scheduleRetry(stream: 'host' | 'mux'): void {
    if (this.abort.signal.aborted || this.retryTimers.has(stream)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(stream)
      if (this.abort.signal.aborted) return
      if (stream === 'host') this.followHostEvents()
      else this.followMuxEvents()
    }, 1_000)
    timer.unref?.()
    this.retryTimers.set(stream, timer)
  }

  private rpcId() {
    return RpcId(randomUUID())
  }
}

function formatQuestions(value: PendingVoiceQuestion): string {
  return value.questions.map((question) => {
    const options = question.options?.map(option => option.label).join('、')
    return `${question.id}: ${question.question}${options === undefined || options === '' ? '' : `（选项：${options}）`}`
  }).join('；')
}

function messageSourceRpcId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = (value as Record<string, unknown>).source
  if (typeof source !== 'object' || source === null) return undefined
  const rpcId = (source as Record<string, unknown>).rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId : undefined
}

function turnEndKind(value: unknown): 'completed' | 'cancelled' | 'failed' {
  const kind = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).kind === 'string'
      ? (value as Record<string, unknown>).kind as string
      : 'completed'
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled') return 'cancelled'
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens' || kind === 'failed') return 'failed'
  return 'completed'
}
