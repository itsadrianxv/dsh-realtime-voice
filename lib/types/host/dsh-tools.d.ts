import type { Context } from '@deepseek-ai/cordis';
interface SessionStatus {
    sessionId: string;
    running: boolean;
    blank: boolean;
    cwd?: string;
    summary?: string;
}
export interface VoiceToolCall {
    callId: string;
    name: string;
    arguments: string;
}
export interface VoiceToolResult {
    ok: boolean;
    output: string;
}
/** Allowlisted translation from realtime-model Function Calls to official DSH API services. */
export declare class DshVoiceTools {
    private readonly ctx;
    private readonly sessionId;
    private readonly completed;
    constructor(ctx: Context, sessionId: string);
    /** Execute one idempotent allowlisted call. Duplicate call ids share the first result. */
    execute(call: VoiceToolCall): Promise<VoiceToolResult>;
    /** Read the current DSH status used both by UI and initial voice context. */
    status(): Promise<SessionStatus>;
    private executeOnce;
    private prompt;
    private lastAssistantText;
    private rpcId;
}
export {};
