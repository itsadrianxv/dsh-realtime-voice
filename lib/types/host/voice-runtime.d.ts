import { type DshVoiceCoordinatorState } from './dsh-coordinator.ts';
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts';
import { type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts';
export interface VoiceContinuityState {
    id: string;
    sessionId: string;
    platform: VoiceClientPlatform;
    createdAt: number;
    lastSeenAt: number;
    userTranscript: string;
    assistantTranscript: string;
    serverSeq: number;
    outputStreamId: number;
    outputSequence: number;
    outputPtsMs: number;
    coordinator: DshVoiceCoordinatorState;
    pendingApproval?: PendingVoiceApproval;
    pendingQuestion?: PendingVoiceQuestion;
}
export interface VoiceLeaseRequest {
    connectionId: string;
    platform: VoiceClientPlatform;
    clientVersion: string;
    sessionId: string;
    resumeId?: string;
    revoke: () => void;
}
export type VoiceLeaseResult = {
    ok: true;
    state: VoiceContinuityState;
    resumed: boolean;
} | {
    ok: false;
    reason: 'busy' | 'invalid-resume';
    occupancy: VoiceOccupancyStatus;
};
/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export declare class VoiceRuntime {
    private readonly retentionMs;
    private readonly reconnectGraceMs;
    private readonly heartbeatTimeoutMs;
    private readonly calls;
    private activeLease;
    constructor(retentionMs?: number, reconnectGraceMs?: number, heartbeatTimeoutMs?: number);
    acquireLease(request: VoiceLeaseRequest): VoiceLeaseResult;
    touch(state: VoiceContinuityState): void;
    release(connectionId: string, retainForResume?: boolean): void;
    occupancy(): VoiceOccupancyStatus;
    clear(): void;
    private sweep;
}
