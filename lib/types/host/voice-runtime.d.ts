import { type DshVoiceCoordinatorState } from './dsh-coordinator.ts';
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts';
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
/**
 * Short-lived continuity ledger for transport reconnects. DSH remains the
 * durable source of task truth; this ledger only restores the conversational
 * edge and any interaction card that was already shown to the caller.
 */
export declare class VoiceRuntime {
    private readonly retentionMs;
    private readonly calls;
    constructor(retentionMs?: number);
    acquire(resumeId: string | undefined, sessionId: string): VoiceContinuityState;
    touch(state: VoiceContinuityState): void;
    clear(): void;
    private sweep;
}
