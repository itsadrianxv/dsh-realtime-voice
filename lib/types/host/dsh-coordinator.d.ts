import type { Context } from '@deepseek-ai/cordis';
interface SessionState {
    sessionId: string;
    running: boolean;
    cwd?: string;
    title?: string;
}
interface WorkerState extends SessionState {
    instruction: string;
}
export interface VoiceCoordinatorCallbacks {
    onWorkerStarted?: (worker: Readonly<WorkerState>) => void;
    onWorkerUpdated?: (worker: Readonly<WorkerState>) => void;
}
export declare const VOICE_COORDINATOR_PROMPT = "## Realtime voice coordinator\n\nThis DSH session is currently the reasoning coordinator for a live voice call. Preserve the session's original instructions, permissions, memory, project context, and ongoing work. The speech provider is only the ears and voice; you are the Agent that decides, answers, and acts.\n\nKeep spoken answers concise and natural. Choose one of three modes:\n\n1. Converse here for discussion, clarification, prioritization, and ordinary questions.\n2. Do a quick check here when it is short and immediately helps the live conversation.\n3. Delegate blocking mechanics with voice_delegate_task when work is slow, multi-step, or can proceed independently, especially file or app operations, printing, browsing, implementation, deep investigation, log collection, deployment, and device or external-service actions. Keep this coordinator responsive while the worker runs.\n\nFor follow-up instructions to a delegated worker, use voice_message_task. Use voice_task_status to inspect it and voice_cancel_task only when the user clearly asks to stop that worker. Worker results will be returned to this coordinator automatically.\n\nNever claim that you cannot access the computer, files, apps, or devices before the appropriate worker has inspected the available DSH tools and permissions. Preserve every concrete constraint in the delegated instruction. For example, a request to find a WeChat document and print it in color, double-sided is blocking mechanics and must be delegated in full, not replaced with manual steps.";
/**
 * Scoped DSH-side coordinator attached only to the Agent session owning one
 * voice call. DSH makes every semantic decision; the audio model gets no tools.
 */
export declare class DshVoiceCoordinator {
    private readonly ctx;
    private readonly sessionId;
    private readonly callbacks;
    private readonly workers;
    private readonly disposers;
    private attached;
    constructor(ctx: Context, sessionId: string, callbacks?: VoiceCoordinatorCallbacks);
    attach(): Promise<void>;
    dispose(): void;
    /** Every completed spoken turn enters the authoritative bound DSH session. */
    submitUserTurn(transcript: string): Promise<void>;
    isWorkerSession(sessionId: string): boolean;
    /** Return one completed worker turn to the coordinator as durable context. */
    returnWorkerResult(workerSessionId: string, text: string): Promise<void>;
    private delegateTool;
    private messageTool;
    private statusTool;
    private cancelTool;
    private delegate;
    private messageWorker;
    private workerStatus;
    private cancelWorker;
    private requireWorker;
    private sessionState;
    private lastAssistantText;
    private rpcId;
}
export {};
