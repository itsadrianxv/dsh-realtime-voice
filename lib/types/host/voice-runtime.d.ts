import { type DshVoiceCoordinatorState } from './dsh-coordinator.ts';
import type { PendingVoiceApproval, PendingVoiceQuestion } from './dsh-coordinator.ts';
import { type VoiceClientPlatform, type VoiceOccupancyStatus } from '../protocol.ts';
import type { VoiceControlProtocol } from '../protocol.ts';
import type { DirectMediaOffer, DirectBackendEventKind, DirectClientMetrics } from '../direct-protocol.ts';
import type { DshFunctionReceipt, DshInteractionReceipt } from './dsh-function-bridge.ts';
import type { DshBackendBridge } from './dsh-backend-bridge.ts';
export interface DirectBackendEventRecord {
    eventId: string;
    eventSeq: number;
    kind: DirectBackendEventKind;
    text: string;
    acknowledged: boolean;
}
export interface DirectVoiceContinuityState {
    backendEvents: Map<string, DirectBackendEventRecord>;
    nextBackendEventSeq: number;
    currentOffer?: DirectMediaOffer;
    activeMedia?: {
        offerId: string;
        mediaSessionId: string;
        connectedAt: number;
    };
    lastOfferIssuedAt?: number;
    metrics?: DirectClientMetrics;
    deliveredFunctionResults: Set<string>;
    pendingOffer?: Promise<DirectMediaOffer>;
    backendBridge?: DshBackendBridge;
}
export interface VoiceContinuityState {
    id: string;
    protocol: VoiceControlProtocol;
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
    functionReceipts: Map<string, DshFunctionReceipt>;
    interactionReceipts: Map<string, DshInteractionReceipt>;
    pendingApproval?: PendingVoiceApproval;
    pendingQuestion?: PendingVoiceQuestion;
    direct?: DirectVoiceContinuityState;
}
export interface VoiceLeaseRequest {
    connectionId: string;
    protocol?: VoiceControlProtocol;
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
    occupancy(inactiveProtocol?: VoiceControlProtocol): VoiceOccupancyStatus;
    clear(): void;
    private sweep;
    private deleteCall;
}
