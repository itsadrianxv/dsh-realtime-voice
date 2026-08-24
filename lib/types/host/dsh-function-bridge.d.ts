import { type DirectDshFunctionName } from '../direct-protocol.ts';
import { DshVoiceCoordinator, type PendingVoiceApproval, type PendingVoiceQuestion, type VoiceQuestionAnswer } from './dsh-coordinator.ts';
export declare const DSH_VOICE_FUNCTION_NAMES: readonly ["handoff_to_dsh_agent", "cancel_dsh_agent", "answer_dsh_approval", "answer_dsh_question"];
export type DshVoiceFunctionName = DirectDshFunctionName;
export interface DshFunctionReceipt {
    name: string;
    fingerprint: string;
    promise: Promise<{
        output: unknown;
        ok: boolean;
    }>;
    settled: boolean;
}
export interface DshFunctionExecution {
    output: unknown;
    ok: boolean;
    cached: boolean;
    conflict?: boolean;
}
export interface DshInteractionReceipt {
    fingerprint: string;
    promise: Promise<unknown>;
    settled: boolean;
}
export interface DshFunctionBridgeCallbacks {
    onApprovalResolved?: (approval: PendingVoiceApproval, outcome: 'allowed-once' | 'rejected') => void;
    onQuestionResolved?: (question: PendingVoiceQuestion) => void;
}
/** Client-neutral, idempotent semantic bridge from a provider Function Call to DSH. */
export declare class DshFunctionBridge {
    private readonly coordinator;
    private readonly receipts;
    private readonly callbacks;
    private readonly interactionReceipts;
    constructor(coordinator: DshVoiceCoordinator, receipts?: Map<string, DshFunctionReceipt>, callbacks?: DshFunctionBridgeCallbacks, interactionReceipts?: Map<string, DshInteractionReceipt>);
    execute(callId: string, name: string, argumentsJson: string, spokenInput: string, providerScope?: string): Promise<DshFunctionExecution>;
    answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<unknown>;
    answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): Promise<unknown>;
    private perform;
    private claimInteraction;
    private dispatch;
}
