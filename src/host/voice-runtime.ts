import { randomUUID } from 'node:crypto'
import { createDshVoiceCoordinatorState, type DshVoiceCoordinatorState } from './dsh-coordinator.ts'
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts'
import { VOICE_PROTOCOL, type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts'

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

export interface VoiceLeaseRequest {
  connectionId: string
  platform: VoiceClientPlatform
  clientVersion: string
  sessionId: string
  resumeId?: string
  revoke: () => void
}

interface ActiveVoiceLease {
  connectionId: string
  platform: VoiceClientPlatform
  clientVersion: string
  sessionId: string
  voiceSessionId: string
  startedAt: number
  lastSeenAt: number
  revoke: () => void
}

export type VoiceLeaseResult =
  | { ok: true; state: VoiceContinuityState; resumed: boolean }
  | { ok: false; occupancy: VoiceOccupancyStatus }

/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export class VoiceRuntime {
  private readonly calls = new Map<string, VoiceContinuityState>()
  private activeLease: ActiveVoiceLease | undefined

  constructor(private readonly retentionMs = 10 * 60_000) {}

  acquireLease(request: VoiceLeaseRequest): VoiceLeaseResult {
    this.sweep()
    const active = this.activeLease
    const mayResume = active !== undefined
      && request.resumeId === active.voiceSessionId
      && request.sessionId === active.sessionId
    if (active !== undefined && !mayResume) {
      return { ok: false, occupancy: this.occupancy() }
    }

    const resumed = request.resumeId === undefined ? undefined : this.calls.get(request.resumeId)
    let state: VoiceContinuityState
    if (resumed !== undefined && resumed.sessionId === request.sessionId) {
      resumed.lastSeenAt = Date.now()
      state = resumed
    } else {
      const now = Date.now()
      state = {
        id: randomUUID(),
        sessionId: request.sessionId,
        createdAt: now,
        lastSeenAt: now,
        userTranscript: '',
        assistantTranscript: '',
        coordinator: createDshVoiceCoordinatorState(),
      }
      this.calls.set(state.id, state)
    }

    const previousRevoke = mayResume ? active?.revoke : undefined
    const startedAt = mayResume && active !== undefined ? active.startedAt : Date.now()
    this.activeLease = {
      connectionId: request.connectionId,
      platform: request.platform,
      clientVersion: request.clientVersion,
      sessionId: request.sessionId,
      voiceSessionId: state.id,
      startedAt,
      lastSeenAt: Date.now(),
      revoke: request.revoke,
    }
    // Publish the replacement before revoking the stale transport. Its close
    // callback may release the old connection id, but can never clear the new lease.
    previousRevoke?.()
    return { ok: true, state, resumed: resumed !== undefined }
  }

  touch(state: VoiceContinuityState): void {
    state.lastSeenAt = Date.now()
    if (this.activeLease?.voiceSessionId === state.id) this.activeLease.lastSeenAt = state.lastSeenAt
  }

  release(connectionId: string): void {
    if (this.activeLease?.connectionId === connectionId) this.activeLease = undefined
  }

  occupancy(): VoiceOccupancyStatus {
    const lease = this.activeLease
    if (lease === undefined) return { protocol: VOICE_PROTOCOL, active: false }
    return {
      protocol: VOICE_PROTOCOL,
      active: true,
      owner: {
        platform: lease.platform,
        clientVersion: lease.clientVersion,
        sessionId: lease.sessionId,
        voiceSessionId: lease.voiceSessionId,
        startedAt: lease.startedAt,
        lastSeenAt: lease.lastSeenAt,
      },
    }
  }

  clear(): void {
    this.activeLease?.revoke()
    this.activeLease = undefined
    this.calls.clear()
  }

  private sweep(): void {
    const expiredBefore = Date.now() - this.retentionMs
    for (const [id, state] of this.calls) {
      if (id !== this.activeLease?.voiceSessionId && state.lastSeenAt < expiredBefore) this.calls.delete(id)
    }
  }
}
