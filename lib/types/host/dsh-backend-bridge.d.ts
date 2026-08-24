import type { Context } from '@deepseek-ai/cordis';
import type { DirectBackendEventKind } from '../direct-protocol.ts';
import { DshVoiceCoordinator, type PendingVoiceApproval, type PendingVoiceQuestion } from './dsh-coordinator.ts';
export interface DshBackendEvent {
    eventId: string;
    kind: DirectBackendEventKind;
    text: string;
}
export interface DshBackendBridgeCallbacks {
    onAgentStatus: (status: {
        sessionId: string;
        running: boolean;
        summary?: string;
    }) => void;
    onApproval: (approval: PendingVoiceApproval, status: 'pending' | 'resolved', outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => void;
    onQuestion: (question: PendingVoiceQuestion, status: 'pending' | 'resolved', outcome?: 'answered' | 'cancelled') => void;
    onBackendEvent: (event: DshBackendEvent) => void;
}
/** Continuity-scoped projection of authoritative DSH events into voice semantics. */
export declare class DshBackendBridge {
    private readonly ctx;
    private readonly sessionId;
    readonly coordinator: DshVoiceCoordinator;
    private callbacks;
    private readonly abort;
    private readonly pendingAssistantByTurn;
    private dshTurnRunning;
    private activeDshJobs;
    private started;
    private readonly retryTimers;
    constructor(ctx: Context, sessionId: string, coordinator: DshVoiceCoordinator, callbacks: DshBackendBridgeCallbacks);
    setCallbacks(callbacks: DshBackendBridgeCallbacks): void;
    start(): Promise<void>;
    emitCurrentStatus(): void;
    stop(): void;
    snapshotPendingInteractions(): void;
    private followHostEvents;
    private followMuxEvents;
    private projectSessionEvent;
    private reconcileHistory;
    private emitAgentStatus;
    private scheduleRetry;
    private rpcId;
}
