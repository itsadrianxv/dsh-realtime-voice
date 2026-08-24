import type { Context } from '@deepseek-ai/cordis';
export interface HandoffRecord {
    handoffId: string;
    promptRpcId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    request: string;
    spokenInput: string;
    status: 'accepted' | 'running' | 'needs-input' | 'completed' | 'cancelled' | 'failed';
    turn?: number;
    queueItemId?: string;
    createdAt: number;
}
export interface PendingVoiceApproval {
    rpcId: string;
    approvalId: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}
export interface VoiceQuestionOption {
    label: string;
    description?: string;
}
export interface VoiceQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: VoiceQuestionOption[];
    multiSelect?: boolean;
}
export interface PendingVoiceQuestion {
    rpcId: string;
    sessionId: string;
    questions: VoiceQuestionItem[];
}
export interface VoiceQuestionAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
export interface DshVoiceCoordinatorState {
    handoffs: Map<string, HandoffRecord>;
    pendingApprovals: Map<string, PendingVoiceApproval>;
    pendingQuestions: Map<string, PendingVoiceQuestion>;
    pendingTurnBindings: Set<string>;
    activeTurn?: number;
}
export declare function createDshVoiceCoordinatorState(): DshVoiceCoordinatorState;
/**
 * The DSH execution plane for one live call. Qwen owns the realtime
 * conversation and invokes this coordinator only for semantic handoffs,
 * corrections, cancellation, approvals, and structured user questions.
 */
export declare class DshVoiceCoordinator {
    private readonly ctx;
    private readonly sessionId;
    private readonly handoffs;
    private readonly pendingApprovals;
    private readonly pendingQuestions;
    private readonly state;
    constructor(ctx: Context, sessionId: string, state?: DshVoiceCoordinatorState);
    /** Start work when idle, or steer the active turn when DSH is already busy. */
    handoff(request: string, spokenInput: string): Promise<HandoffRecord>;
    /** Cancel the authoritative bound DSH turn; there is no shadow worker. */
    cancel(reason?: string): Promise<{
        sessionId: string;
        status: 'cancellation-requested';
        accepted: true;
    }>;
    /** Capture the transient inbox identity so cancellation removes only work owned by this voice call. */
    observeQueue(items: readonly unknown[]): void;
    markTurnStarted(turn: number): void;
    /** Bind a handoff only after its durable user/message echoes the prompt rpcId. */
    observeUserMessage(promptRpcId: string): void;
    /** Events after user/message carry the turn number needed to finish binding. */
    observeTurnEvent(turn: number): void;
    markNeedsInput(): void;
    markTurnEnded(turn: number, reason: string): HandoffRecord[];
    markFailed(): void;
    rememberApproval(approval: PendingVoiceApproval): void;
    forgetApproval(approvalId: string): void;
    listPendingApprovals(): PendingVoiceApproval[];
    resolveApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<{
        approvalId: string;
        outcome: 'allowed-once' | 'rejected';
        accepted: true;
    }>;
    rememberQuestion(question: PendingVoiceQuestion): void;
    forgetQuestion(rpcId: string): void;
    listPendingQuestions(): PendingVoiceQuestion[];
    answerQuestion(rpcId: string, answers: VoiceQuestionAnswer[]): Promise<{
        rpcId: string;
        accepted: true;
    }>;
    get active(): boolean;
    private activeHandoffs;
    private sessionState;
    private rpcId;
}
