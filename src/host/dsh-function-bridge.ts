import { createHash } from 'node:crypto'
import {
  DIRECT_DSH_FUNCTION_NAMES,
  DIRECT_FUNCTION_ARGUMENT_MAX_BYTES,
  isDirectDshFunctionName,
  isDirectFunctionArguments,
  type DirectDshFunctionName,
} from '../direct-protocol.ts'
import {
  DshVoiceCoordinator,
  type PendingVoiceApproval,
  type PendingVoiceQuestion,
  type VoiceQuestionAnswer,
} from './dsh-coordinator.ts'

export const DSH_VOICE_FUNCTION_NAMES = DIRECT_DSH_FUNCTION_NAMES
export type DshVoiceFunctionName = DirectDshFunctionName

export interface DshFunctionReceipt {
  name: string
  fingerprint: string
  promise: Promise<{ output: unknown; ok: boolean }>
  settled: boolean
}

export interface DshFunctionExecution {
  output: unknown
  ok: boolean
  cached: boolean
  conflict?: boolean
}

export interface DshInteractionReceipt {
  fingerprint: string
  promise: Promise<unknown>
  settled: boolean
}

export interface DshFunctionBridgeCallbacks {
  onApprovalResolved?: (approval: PendingVoiceApproval, outcome: 'allowed-once' | 'rejected') => void
  onQuestionResolved?: (question: PendingVoiceQuestion) => void
}

/** Client-neutral, idempotent semantic bridge from a provider Function Call to DSH. */
export class DshFunctionBridge {
  constructor(
    private readonly coordinator: DshVoiceCoordinator,
    private readonly receipts: Map<string, DshFunctionReceipt> = new Map(),
    private readonly callbacks: DshFunctionBridgeCallbacks = {},
    private readonly interactionReceipts: Map<string, DshInteractionReceipt> = new Map(),
  ) {}

  async execute(
    callId: string,
    name: string,
    argumentsJson: string,
    spokenInput: string,
    providerScope = 'legacy-provider',
  ): Promise<DshFunctionExecution> {
    try { validateEnvelope(callId, name, argumentsJson) } catch (error) {
      return failure(error, false)
    }
    const fingerprint = fingerprintCall(name, argumentsJson)
    const receiptKey = `${providerScope}\0${callId}`
    const existing = this.receipts.get(receiptKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint || existing.name !== name) {
        return { ...failure('Function callId was reused with different content', true), conflict: true }
      }
      return { ...await existing.promise, cached: true }
    }
    pruneSettledReceipts(this.receipts, 255)
    if (this.receipts.size >= 256) {
      return {
        output: { status: 'failed', error: 'Too many concurrent realtime bridge calls' },
        ok: false,
        cached: false,
      }
    }
    const promise = this.perform(name as DshVoiceFunctionName, parseArguments(argumentsJson), spokenInput)
    // Register before awaiting so concurrent duplicates share one execution.
    const receipt: DshFunctionReceipt = { name, fingerprint, promise, settled: false }
    this.receipts.set(receiptKey, receipt)
    void promise.then(() => {
      receipt.settled = true
      pruneSettledReceipts(this.receipts, 256)
    })
    return { ...await promise, cached: false }
  }

  async answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<unknown> {
    const key = `approval:${approvalId}`
    const fingerprint = outcome
    const existing = this.interactionReceipts.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('DSH approval is already resolving with a different outcome')
      return existing.promise
    }
    const pending = this.coordinator.listPendingApprovals().find(value => value.approvalId === approvalId)
    if (pending === undefined) throw new Error(`DSH approval is no longer pending: ${approvalId}`)
    return this.claimInteraction(key, fingerprint, async () => {
      const output = await this.coordinator.resolveApproval(approvalId, outcome)
      this.coordinator.forgetApproval(approvalId)
      this.callbacks.onApprovalResolved?.(pending, outcome)
      return output
    })
  }

  async answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): Promise<unknown> {
    const key = `question:${requestId}`
    const fingerprint = fingerprintCall('answer', JSON.stringify(answers))
    const existing = this.interactionReceipts.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('DSH question is already resolving with different answers')
      return existing.promise
    }
    const pending = this.coordinator.listPendingQuestions().find(value => value.rpcId === requestId)
    if (pending === undefined) throw new Error(`DSH question is no longer pending: ${requestId}`)
    return this.claimInteraction(key, fingerprint, async () => {
      const output = await this.coordinator.answerQuestion(requestId, answers)
      this.coordinator.forgetQuestion(requestId)
      this.callbacks.onQuestionResolved?.(pending)
      return output
    })
  }

  private async perform(
    name: DshVoiceFunctionName,
    args: Record<string, unknown>,
    spokenInput: string,
  ): Promise<{ output: unknown; ok: boolean }> {
    try {
      const output = await this.dispatch(name, args, spokenInput)
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > DIRECT_FUNCTION_ARGUMENT_MAX_BYTES) {
        throw new Error('DSH function result exceeds the 16 KiB limit')
      }
      return { output, ok: true }
    } catch (error) {
      return failure(error, false)
    }
  }

  private async claimInteraction(key: string, fingerprint: string, action: () => Promise<unknown>): Promise<unknown> {
    if (this.interactionReceipts.size >= 128) {
      for (const [receiptKey, receipt] of this.interactionReceipts) {
        if (receipt.settled) this.interactionReceipts.delete(receiptKey)
        if (this.interactionReceipts.size < 128) break
      }
    }
    if (this.interactionReceipts.size >= 128) throw new Error('Too many retained DSH interaction receipts')
    const promise = action()
    const receipt: DshInteractionReceipt = { fingerprint, promise, settled: false }
    this.interactionReceipts.set(key, receipt)
    void promise.then(() => { receipt.settled = true }, () => { this.interactionReceipts.delete(key) })
    return promise
  }

  private async dispatch(name: DshVoiceFunctionName, args: Record<string, unknown>, spokenInput: string): Promise<unknown> {
    switch (name) {
      case 'handoff_to_dsh_agent': {
        assertOnlyKeys(args, ['instruction'])
        const handoff = await this.coordinator.handoff(requiredString(args, 'instruction', 12_000), spokenInput)
        return {
          status: 'accepted',
          handoff_id: handoff.handoffId,
          target_session_id: handoff.sessionId,
          mode: handoff.mode,
        }
      }
      case 'cancel_dsh_agent': {
        assertOnlyKeys(args, ['reason'])
        return this.coordinator.cancel(optionalString(args, 'reason', 1_000) ?? '')
      }
      case 'answer_dsh_approval': {
        assertOnlyKeys(args, ['approval_id', 'decision'])
        const decision = requiredString(args, 'decision', 32)
        if (decision !== 'allowed-once' && decision !== 'rejected') {
          throw new Error('approval decision must be allowed-once or rejected')
        }
        return this.answerApproval(requiredString(args, 'approval_id', 256), decision)
      }
      case 'answer_dsh_question': {
        assertOnlyKeys(args, ['request_id', 'answers'])
        return this.answerQuestion(requiredString(args, 'request_id', 256), parseQuestionAnswers(args.answers))
      }
    }
  }
}

function validateEnvelope(callId: string, name: string, argumentsJson: string): void {
  if (callId.length === 0 || callId.length > 128) throw new Error('Function callId is invalid')
  if (!isDirectDshFunctionName(name)) throw new Error(`Unknown realtime bridge tool: ${name}`)
  if (new TextEncoder().encode(argumentsJson).byteLength > DIRECT_FUNCTION_ARGUMENT_MAX_BYTES) {
    throw new Error('Function arguments exceed the 16 KiB limit')
  }
  if (!isDirectFunctionArguments(name, argumentsJson)) throw new Error('Function arguments do not match the declared tool schema')
}

function failure(error: unknown, cached: boolean): DshFunctionExecution {
  const raw = error instanceof Error ? error.message : String(error)
  const safe = raw.replaceAll(/(Bearer\s+|sk-|st-)[A-Za-z0-9._-]+/gi, '$1***').slice(0, 512)
  return { output: { status: 'failed', error: safe }, ok: false, cached }
}

function fingerprintCall(name: string, argumentsJson: string): string {
  return createHash('sha256').update(name).update('\0').update(argumentsJson).digest('hex')
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = value.trim() === '' ? {} : JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Function arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, name: string, maxLength: number): string {
  const result = optionalString(value, name, maxLength)
  if (result === undefined || result.trim() === '') throw new Error(`Missing required string argument: ${name}`)
  return result.trim()
}

function optionalString(value: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const result = value[name]
  if (result === undefined) return undefined
  if (typeof result !== 'string') throw new Error(`Argument must be a string: ${name}`)
  if (result.length > maxLength) throw new Error(`Argument is too long: ${name}`)
  return result
}

function parseQuestionAnswers(value: unknown): VoiceQuestionAnswer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw new Error('answers must be a non-empty array')
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('answer must be an object')
    const answer = entry as Record<string, unknown>
    assertOnlyKeys(answer, ['id', 'selected', 'custom'])
    const id = requiredString(answer, 'id', 128)
    if (!Array.isArray(answer.selected)
      || answer.selected.length > 16
      || !answer.selected.every(item => typeof item === 'string' && item.length <= 256)) {
      throw new Error(`answer.selected must be a string array: ${id}`)
    }
    const custom = optionalString(answer, 'custom', 4_000)
    return { id, selected: answer.selected, ...(custom === undefined ? {} : { custom }) }
  })
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(`Unexpected function argument: ${unexpected}`)
}

function pruneSettledReceipts(receipts: Map<string, DshFunctionReceipt>, targetSize: number): void {
  if (receipts.size <= targetSize) return
  for (const [callId, receipt] of receipts) {
    if (!receipt.settled) continue
    receipts.delete(callId)
    if (receipts.size <= targetSize) return
  }
}
