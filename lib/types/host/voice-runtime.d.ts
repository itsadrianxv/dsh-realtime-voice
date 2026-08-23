import { type DshVoiceCoordinatorState } from './dsh-coordinator.ts';
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts';
import { type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts';
export interface VoiceContinuityState {
    id: string;
    sessionId: string;
    createdAt: number;
    lastSeenAt: number;
    userTranscript: string;
    assistantTranscript: string;
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
    occupancy: VoiceOccupancyStatus;
};
/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export declare class VoiceRuntime {
    private readonly retentionMs;
    private readonly calls;
    private activeLease;
    constructor(retentionMs?: number);
    acquireLease(request: VoiceLeaseRequest): VoiceLeaseResult;
    touch(state: VoiceContinuityState): void;
    release(connectionId: string): void;
    occupancy(): VoiceOccupancyStatus;
    clear(): void;
    private sweep;
}
