import { randomUUID } from 'node:crypto'
import { createDshVoiceCoordinatorState, type DshVoiceCoordinatorState } from './dsh-coordinator.ts'
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts'
import { VOICE_PROTOCOL, type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts'

export interface VoiceContinuityState {
  id: string
  sessionId: string
  platform: VoiceClientPlatform
  createdAt: number
  lastSeenAt: number
  userTranscript: string
  assistantTranscript: string
  serverSeq: number
  outputStreamId: number
  outputSequence: number
  outputPtsMs: number
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
  connected: boolean
  disconnectedAt?: number
  revoke: () => void
}

export type VoiceLeaseResult =
  | { ok: true; state: VoiceContinuityState; resumed: boolean }
  | { ok: false; reason: 'busy' | 'invalid-resume'; occupancy: VoiceOccupancyStatus }

/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export class VoiceRuntime {
  private readonly calls = new Map<string, VoiceContinuityState>()
  private activeLease: ActiveVoiceLease | undefined

  constructor(
    private readonly retentionMs = 10 * 60_000,
    private readonly reconnectGraceMs = 30_000,
    private readonly heartbeatTimeoutMs = 45_000,
  ) {}

  acquireLease(request: VoiceLeaseRequest): VoiceLeaseResult {
    this.sweep()
    const active = this.activeLease
    const mayResume = active !== undefined
      && !active.connected
      && request.resumeId === active.voiceSessionId
      && request.sessionId === active.sessionId
      && request.platform === active.platform
    if (active !== undefined && !mayResume) {
      return { ok: false, reason: 'busy', occupancy: this.occupancy() }
    }

    const resumed = request.resumeId === undefined ? undefined : this.calls.get(request.resumeId)
    if (request.resumeId !== undefined
      && (resumed === undefined || resumed.sessionId !== request.sessionId || resumed.platform !== request.platform)) {
      return { ok: false, reason: 'invalid-resume', occupancy: this.occupancy() }
    }
    let state: VoiceContinuityState
    if (resumed !== undefined && resumed.sessionId === request.sessionId) {
      resumed.lastSeenAt = Date.now()
      state = resumed
    } else {
      const now = Date.now()
      state = {
        id: randomUUID(),
        sessionId: request.sessionId,
        platform: request.platform,
        createdAt: now,
        lastSeenAt: now,
        userTranscript: '',
        assistantTranscript: '',
        serverSeq: 0,
        outputStreamId: 1,
        outputSequence: 0,
        outputPtsMs: 0,
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
      connected: true,
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

  release(connectionId: string, retainForResume = false): void {
    const lease = this.activeLease
    if (lease?.connectionId !== connectionId) return
    if (!retainForResume) {
      this.activeLease = undefined
      this.calls.delete(lease.voiceSessionId)
      return
    }
    lease.connected = false
    lease.disconnectedAt = Date.now()
    lease.lastSeenAt = lease.disconnectedAt
  }

  occupancy(): VoiceOccupancyStatus {
    this.sweep()
    const lease = this.activeLease
    if (lease === undefined) return { protocol: VOICE_PROTOCOL, active: false }
    return {
      protocol: VOICE_PROTOCOL,
      active: true,
      owner: {
        platform: lease.platform,
        clientVersion: lease.clientVersion,
        sessionId: lease.sessionId,
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
    const now = Date.now()
    const lease = this.activeLease
    if (lease !== undefined) {
      const disconnectedExpired = !lease.connected
        && lease.disconnectedAt !== undefined
        && lease.disconnectedAt < now - this.reconnectGraceMs
      const heartbeatExpired = lease.connected && lease.lastSeenAt < now - this.heartbeatTimeoutMs
      if (disconnectedExpired || heartbeatExpired) {
        this.activeLease = undefined
        lease.revoke()
      }
    }
    const expiredBefore = now - this.retentionMs
    for (const [id, state] of this.calls) {
      if (id !== this.activeLease?.voiceSessionId && state.lastSeenAt < expiredBefore) this.calls.delete(id)
    }
  }
}
