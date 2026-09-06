import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
const SessionId = (value: string): any => value
const RpcId = (value: string): any => value

interface SessionState {
  sessionId: string
  running: boolean
  cwd?: string
  title?: string
}

export interface HandoffRecord {
  handoffId: string
  promptRpcId: string
  sessionId: string
  mode: 'queue' | 'steer'
  request: string
  spokenInput: string
  status: 'accepted' | 'running' | 'needs-input' | 'completed' | 'cancelled' | 'failed'
  turn?: number
  queueItemId?: string
  createdAt: number
}

export interface PendingVoiceApproval {
  rpcId: string
  approvalId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface VoiceQuestionOption {
  label: string
  description?: string
}

export interface VoiceQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: VoiceQuestionOption[]
  multiSelect?: boolean
}

export interface PendingVoiceQuestion {
  rpcId: string
  sessionId: string
  questions: VoiceQuestionItem[]
}

export interface VoiceQuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface DshVoiceCoordinatorState {
  handoffs: Map<string, HandoffRecord>
  pendingApprovals: Map<string, PendingVoiceApproval>
  pendingQuestions: Map<string, PendingVoiceQuestion>
  pendingTurnBindings: Set<string>
  activeTurn?: number
}

export function createDshVoiceCoordinatorState(): DshVoiceCoordinatorState {
  return {
    handoffs: new Map(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    pendingTurnBindings: new Set(),
  }
}

/**
 * The DSH execution plane for one live call. Qwen owns the realtime
 * conversation and invokes this coordinator only for semantic handoffs,
 * corrections, cancellation, approvals, and structured user questions.
 */
export class DshVoiceCoordinator {
  private readonly handoffs: Map<string, HandoffRecord>
  private readonly pendingApprovals: Map<string, PendingVoiceApproval>
  private readonly pendingQuestions: Map<string, PendingVoiceQuestion>
  private readonly state: DshVoiceCoordinatorState

  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string,
    state: DshVoiceCoordinatorState = createDshVoiceCoordinatorState(),
  ) {
    this.state = state
    this.handoffs = state.handoffs
    this.pendingApprovals = state.pendingApprovals
    this.pendingQuestions = state.pendingQuestions
  }

  /** Start work when idle, or steer the active turn when DSH is already busy. */
  async handoff(request: string, spokenInput: string): Promise<HandoffRecord> {
    const normalizedRequest = request.trim()
    if (normalizedRequest === '') throw new Error('Realtime handoff request is empty')
    const state = await this.sessionState(this.sessionId)
    const mode = state.running ? 'steer' : 'queue'
    const handoffId = `handoff_${randomUUID()}`
    const promptRpcId = this.rpcId()
    const record: HandoffRecord = {
      handoffId,
      promptRpcId,
      sessionId: this.sessionId,
      mode,
      request: normalizedRequest,
      spokenInput: spokenInput.trim(),
      status: state.running ? 'running' : 'accepted',
      createdAt: Date.now(),
    }
    this.handoffs.set(handoffId, record)
    const response = await this.ctx.apiProxy.sessions.prompt({
      rpcId: promptRpcId,
      payload: {
        sessionId: SessionId(this.sessionId),
        mode,
        content: [{ type: 'text', text: handoffMessage(record) }],
      },
    })
    if (!response.result.ok) {
      record.status = 'failed'
      throw new Error(response.result.error.message)
    }
    return { ...record }
  }

  /** Cancel the authoritative bound DSH turn; there is no shadow worker. */
  async cancel(reason = ''): Promise<{ sessionId: string; status: 'cancellation-requested'; accepted: true }> {
    for (const record of this.activeHandoffs().filter(candidate => candidate.turn === undefined && candidate.queueItemId !== undefined)) {
      const response = await this.ctx.apiProxy.sessions.updateQueue({
        rpcId: this.rpcId(),
        payload: {
          sessionId: SessionId(this.sessionId),
          itemId: record.queueItemId as never,
          action: { kind: 'remove' },
        },
      })
      if (response.result.ok) record.status = 'cancelled'
    }
    const response = await this.ctx.apiProxy.sessions.cancel({
      rpcId: this.rpcId(),
      payload: { sessionId: SessionId(this.sessionId) },
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
    void reason
    return { sessionId: this.sessionId, status: 'cancellation-requested', accepted: true }
  }

  /** Capture the transient inbox identity so cancellation removes only work owned by this voice call. */
  observeQueue(items: readonly unknown[]): void {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const value = item as Record<string, unknown>
      const message = value.message
      const promptRpcId = messageSourceRpcId(message)
      if (typeof value.id !== 'string' || promptRpcId === undefined) continue
      const record = [...this.handoffs.values()].find(candidate => candidate.promptRpcId === promptRpcId)
      if (record !== undefined && isActive(record)) record.queueItemId = value.id
    }
  }

  markTurnStarted(turn: number): void {
    this.state.activeTurn = turn
  }

  /** Bind a handoff only after its durable user/message echoes the prompt rpcId. */
  observeUserMessage(promptRpcId: string): void {
    const record = [...this.handoffs.values()].find(candidate => candidate.promptRpcId === promptRpcId)
    if (record === undefined || !isActive(record)) return
    record.status = 'running'
    if (this.state.activeTurn === undefined) this.state.pendingTurnBindings.add(record.handoffId)
    else record.turn = this.state.activeTurn
  }

  /** Events after user/message carry the turn number needed to finish binding. */
  observeTurnEvent(turn: number): void {
    this.state.activeTurn ??= turn
    for (const handoffId of this.state.pendingTurnBindings) {
      const record = this.handoffs.get(handoffId)
      if (record !== undefined && isActive(record)) record.turn = turn
    }
    this.state.pendingTurnBindings.clear()
  }

  markNeedsInput(): void {
    const active = this.activeHandoffs()
    const scoped = this.state.activeTurn === undefined
      ? active
      : active.filter(record => record.turn === this.state.activeTurn)
    for (const record of scoped) record.status = 'needs-input'
  }

  markTurnEnded(turn: number, reason: string): HandoffRecord[] {
    this.observeTurnEvent(turn)
    const ended: HandoffRecord[] = []
    for (const record of this.activeHandoffs()) {
      if (record.turn !== turn) continue
      record.status = reason === 'cancelled' || reason === 'interrupted' ? 'cancelled'
        : reason === 'error' || reason === 'failed' ? 'failed'
          : 'completed'
      ended.push({ ...record })
    }
    if (this.state.activeTurn === turn) delete this.state.activeTurn
    return ended
  }

  markFailed(): void {
    const active = this.activeHandoffs()
    const scoped = this.state.activeTurn === undefined
      ? active
      : active.filter(record => record.turn === this.state.activeTurn)
    for (const record of scoped) record.status = 'failed'
    this.state.pendingTurnBindings.clear()
    delete this.state.activeTurn
  }

  rememberApproval(approval: PendingVoiceApproval): void {
    this.pendingApprovals.set(approval.approvalId, approval)
    this.markNeedsInput()
  }

  forgetApproval(approvalId: string): void {
    this.pendingApprovals.delete(approvalId)
  }

  listPendingApprovals(): PendingVoiceApproval[] {
    return [...this.pendingApprovals.values()].map(value => ({ ...value }))
  }

  async resolveApproval(
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<{ approvalId: string; outcome: 'allowed-once' | 'rejected'; accepted: true }> {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined) throw new Error(`DSH approval is no longer pending: ${approvalId}`)
    const receipt = await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId: RpcId(pending.rpcId),
      result: {
        ok: true,
        value: {
          sessionId: SessionId(pending.sessionId),
          approvalId: pending.approvalId,
          outcome,
        },
      },
    } as never)
    if (!receipt.accepted) throw new Error(`DSH approval response was rejected: ${receipt.reason}`)
    return { approvalId, outcome, accepted: true }
  }

  rememberQuestion(question: PendingVoiceQuestion): void {
    this.pendingQuestions.set(question.rpcId, question)
    this.markNeedsInput()
  }

  forgetQuestion(rpcId: string): void {
    this.pendingQuestions.delete(rpcId)
  }

  listPendingQuestions(): PendingVoiceQuestion[] {
    return [...this.pendingQuestions.values()].map(value => ({
      ...value,
      questions: value.questions.map(question => ({
        ...question,
        ...(question.options === undefined
          ? {}
          : { options: question.options.map(option => ({ ...option })) }),
      })),
    }))
  }

  async answerQuestion(
    rpcId: string,
    answers: VoiceQuestionAnswer[],
  ): Promise<{ rpcId: string; accepted: true }> {
    const pending = this.pendingQuestions.get(rpcId)
    if (pending === undefined) throw new Error(`DSH question is no longer pending: ${rpcId}`)
    validateQuestionAnswers(pending, answers)
    const receipt = await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: {
        ok: true,
        value: {
          sessionId: SessionId(pending.sessionId),
          answer: { answers },
        },
      },
    } as never)
    if (!receipt.accepted) throw new Error(`DSH question response was rejected: ${receipt.reason}`)
    return { rpcId, accepted: true }
  }

  get active(): boolean {
    return this.activeHandoffs().length > 0
  }

  private activeHandoffs(): HandoffRecord[] {
    return [...this.handoffs.values()].filter(isActive)
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

  private rpcId() {
    return RpcId(randomUUID())
  }
}

function isActive(record: HandoffRecord): boolean {
  return record.status === 'accepted' || record.status === 'running' || record.status === 'needs-input'
}

function handoffMessage(record: HandoffRecord): string {
  const spoken = record.spokenInput === '' ? '' : `\n  <spoken_input>${escapeXml(record.spokenInput)}</spoken_input>`
  return `<realtime_delegation handoff_id="${record.handoffId}" mode="${record.mode}">
  <input>${escapeXml(record.request)}</input>${spoken}
</realtime_delegation>

This is an execution handoff from the live voice surface. Preserve the user's constraints and use the session's normal tools, permissions, project context, and memory. Report useful progress in ordinary assistant commentary. If approval or a user decision is needed, request it through the normal DSH mechanism. Do not merely explain manual steps when the available tools can perform the task.`
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function projectionTitle(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const title = (value as Record<string, unknown>).title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (typeof title !== 'object' || title === null) return undefined
  const nested = (title as Record<string, unknown>).title
  return typeof nested === 'string' && nested.trim() !== '' ? nested.trim() : undefined
}

function messageSourceRpcId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as Record<string, unknown>).source
  if (typeof source !== 'object' || source === null) return undefined
  const rpcId = (source as Record<string, unknown>).rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}

function validateQuestionAnswers(pending: PendingVoiceQuestion, answers: VoiceQuestionAnswer[]): void {
  const byId = new Map<string, VoiceQuestionAnswer>()
  for (const answer of answers) {
    if (byId.has(answer.id)) throw new Error(`DSH question answer is duplicated: ${answer.id}`)
    byId.set(answer.id, answer)
  }
  if (byId.size !== pending.questions.length) throw new Error('Every DSH question must be answered exactly once')
  for (const question of pending.questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) throw new Error(`DSH question is unanswered: ${question.id}`)
    if (new Set(answer.selected).size !== answer.selected.length) {
      throw new Error(`DSH question contains duplicate selections: ${question.id}`)
    }
    if (question.multiSelect !== true && answer.selected.length > 1) {
      throw new Error(`DSH question only accepts one selection: ${question.id}`)
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    if (labels.size > 0 && answer.selected.some(label => !labels.has(label))) {
      throw new Error(`DSH question contains an unknown option: ${question.id}`)
    }
    if (answer.selected.length === 0 && (answer.custom?.trim() ?? '') === '') {
      throw new Error(`DSH question is unanswered: ${question.id}`)
    }
  }
}
