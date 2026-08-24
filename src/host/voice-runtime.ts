import { randomUUID } from 'node:crypto'
import { createDshVoiceCoordinatorState, type DshVoiceCoordinatorState } from './dsh-coordinator.ts'
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts'
import { VOICE_PROTOCOL, type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts'
import type { VoiceControlProtocol } from '../protocol.ts'
import type { DirectMediaOffer, DirectBackendEventKind, DirectClientMetrics, DirectTranscriptCheckpoint } from '../direct-protocol.ts'
import type { DshFunctionReceipt, DshInteractionReceipt } from './dsh-function-bridge.ts'
import type { DshBackendBridge } from './dsh-backend-bridge.ts'

export interface DirectBackendEventRecord {
  eventId: string
  eventSeq: number
  kind: DirectBackendEventKind
  text: string
  acknowledged: boolean
}

export interface DirectVoiceContinuityState {
  backendEvents: Map<string, DirectBackendEventRecord>
  nextBackendEventSeq: number
  currentOffer?: DirectMediaOffer
  activeMedia?: { offerId: string; mediaSessionId: string; connectedAt: number }
  lastOfferIssuedAt?: number
  metrics?: DirectClientMetrics
  deliveredFunctionResults: Set<string>
  pendingOffer?: Promise<DirectMediaOffer>
  transcriptCheckpoint?: DirectTranscriptCheckpoint
  backendBridge?: DshBackendBridge
}

export interface VoiceContinuityState {
  id: string
  protocol: VoiceControlProtocol
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
  functionReceipts: Map<string, DshFunctionReceipt>
  interactionReceipts: Map<string, DshInteractionReceipt>
  pendingApproval?: PendingVoiceApproval
  pendingQuestion?: PendingVoiceQuestion
  direct?: DirectVoiceContinuityState
}

export interface VoiceLeaseRequest {
  connectionId: string
  protocol?: VoiceControlProtocol
  platform: VoiceClientPlatform
  clientVersion: string
  sessionId: string
  resumeId?: string
  revoke: () => void
}

interface ActiveVoiceLease {
  connectionId: string
  protocol: VoiceControlProtocol
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

export interface VoiceReleaseRequest {
  protocol: VoiceControlProtocol
  platform: VoiceClientPlatform
  sessionId: string
  resumeId: string
}

export type VoiceReleaseResult =
  | { ok: true }
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
    const protocol = request.protocol ?? VOICE_PROTOCOL
    const mayResume = active !== undefined
      && !active.connected
      && protocol === active.protocol
      && request.resumeId === active.voiceSessionId
      && request.sessionId === active.sessionId
      && request.platform === active.platform
    if (active !== undefined && !mayResume) {
      return { ok: false, reason: 'busy', occupancy: this.occupancy(protocol) }
    }

    // A resume capability is valid only while its disconnected lease remains
    // inside the bounded grace interval. Retained call data is not authority.
    if (request.resumeId !== undefined && !mayResume) {
      return { ok: false, reason: 'invalid-resume', occupancy: this.occupancy(protocol) }
    }

    const resumed = request.resumeId === undefined ? undefined : this.calls.get(request.resumeId)
    if (request.resumeId !== undefined
      && (resumed === undefined
        || resumed.protocol !== protocol
        || resumed.sessionId !== request.sessionId
        || resumed.platform !== request.platform)) {
      return { ok: false, reason: 'invalid-resume', occupancy: this.occupancy(protocol) }
    }
    let state: VoiceContinuityState
    if (resumed !== undefined && resumed.sessionId === request.sessionId) {
      resumed.lastSeenAt = Date.now()
      state = resumed
    } else {
      const now = Date.now()
      state = {
        id: randomUUID(),
        protocol,
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
        functionReceipts: new Map(),
        interactionReceipts: new Map(),
      }
      this.calls.set(state.id, state)
    }

    const previousRevoke = mayResume ? active?.revoke : undefined
    const startedAt = mayResume && active !== undefined ? active.startedAt : Date.now()
    this.activeLease = {
      connectionId: request.connectionId,
      protocol,
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

  /** Atomically consume a disconnected owner's resume capability and release its lease. */
  resumeAndRelease(request: VoiceReleaseRequest): VoiceReleaseResult {
    this.sweep()
    const active = this.activeLease
    if (active === undefined) {
      return { ok: false, reason: 'invalid-resume', occupancy: this.occupancy(request.protocol) }
    }
    const state = this.calls.get(request.resumeId)
    const matches = !active.connected
      && active.protocol === request.protocol
      && active.platform === request.platform
      && active.sessionId === request.sessionId
      && active.voiceSessionId === request.resumeId
      && state?.protocol === request.protocol
      && state.sessionId === request.sessionId
      && state.platform === request.platform
    if (!matches) return { ok: false, reason: 'busy', occupancy: this.occupancy(request.protocol) }
    this.activeLease = undefined
    this.deleteCall(active.voiceSessionId)
    return { ok: true }
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
      this.deleteCall(lease.voiceSessionId)
      return
    }
    lease.connected = false
    lease.disconnectedAt = Date.now()
    lease.lastSeenAt = lease.disconnectedAt
  }

  occupancy(inactiveProtocol: VoiceControlProtocol = VOICE_PROTOCOL): VoiceOccupancyStatus {
    this.sweep()
    const lease = this.activeLease
    if (lease === undefined) return { protocol: inactiveProtocol, active: false }
    return {
      protocol: inactiveProtocol,
      active: true,
      owner: {
        controlProtocol: lease.protocol,
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
    for (const id of this.calls.keys()) this.deleteCall(id)
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
        this.deleteCall(lease.voiceSessionId)
        lease.revoke()
      }
    }
    const expiredBefore = now - this.retentionMs
    for (const [id, state] of this.calls) {
      if (id !== this.activeLease?.voiceSessionId && state.lastSeenAt < expiredBefore) this.deleteCall(id)
    }
  }

  private deleteCall(id: string): void {
    this.calls.get(id)?.direct?.backendBridge?.stop()
    this.calls.delete(id)
  }
}
