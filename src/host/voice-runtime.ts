import { randomUUID } from 'node:crypto'
import { createDshVoiceCoordinatorState, type DshVoiceCoordinatorState } from './dsh-coordinator.ts'
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts'

export interface VoiceContinuityState {
  id: string
  sessionId: string
  createdAt: number
  lastSeenAt: number
  userTranscript: string
  assistantTranscript: string
  coordinator: DshVoiceCoordinatorState
  pendingApproval?: PendingVoiceApproval
  pendingQuestion?: PendingVoiceQuestion
}

/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export class VoiceRuntime {
  private readonly calls = new Map<string, VoiceContinuityState>()

  constructor(private readonly retentionMs = 10 * 60_000) {}

  acquire(resumeId: string | undefined, sessionId: string): VoiceContinuityState {
    this.sweep()
    const resumed = resumeId === undefined ? undefined : this.calls.get(resumeId)
    if (resumed !== undefined && resumed.sessionId === sessionId) {
      resumed.lastSeenAt = Date.now()
      return resumed
    }
    const now = Date.now()
    const created: VoiceContinuityState = {
      id: randomUUID(),
      sessionId,
      createdAt: now,
      lastSeenAt: now,
      userTranscript: '',
      assistantTranscript: '',
      coordinator: createDshVoiceCoordinatorState(),
    }
    this.calls.set(created.id, created)
    return created
  }

  touch(state: VoiceContinuityState): void {
    state.lastSeenAt = Date.now()
  }

  clear(): void {
    this.calls.clear()
  }

  private sweep(): void {
    const expiredBefore = Date.now() - this.retentionMs
    for (const [id, state] of this.calls) {
      if (state.lastSeenAt < expiredBefore) this.calls.delete(id)
    }
  }
}
