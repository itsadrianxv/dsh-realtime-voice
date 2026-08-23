import type { Context } from '@deepseek-ai/cordis';
export interface VoiceSessionSnapshot {
    sessionId: string;
    running: boolean;
    blank: boolean;
    cwd?: string;
    title?: string;
    summary?: string;
}
/** Read-only state used to bind the audio transport to one authoritative DSH Agent. */
export declare class DshVoiceSession {
    private readonly ctx;
    private readonly sessionId;
    constructor(ctx: Context, sessionId: string);
    snapshot(): Promise<VoiceSessionSnapshot>;
    private lastAssistantText;
    private rpcId;
}
export declare function assistantText(value: unknown): string | undefined;
