import WebSocket, { type ClientOptions } from 'ws';
import type { VoiceConfig } from './config.ts';
import type { VoiceToolCall, VoiceToolResult } from './dsh-tools.ts';
export interface DashScopeRealtimeCallbacks {
    onEvent: (event: DashScopeServerEvent) => void;
    onTool: (call: VoiceToolCall) => Promise<VoiceToolResult>;
}
export type DashScopeServerEvent = Record<string, unknown> & {
    type: string;
};
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket;
/** One upstream Qwen-Audio Realtime session with contained Function Calling. */
export declare class DashScopeRealtime {
    private readonly config;
    private readonly apiKey;
    private readonly instructions;
    private readonly callbacks;
    private readonly socketFactory;
    private socket;
    private readonly pendingTools;
    private readonly queuedAgentAnnouncements;
    private readonly announcedEventSeqs;
    private responseActive;
    private responseRequested;
    private inputSpeechActive;
    private closed;
    constructor(config: VoiceConfig, apiKey: string, instructions: string, callbacks: DashScopeRealtimeCallbacks, socketFactory?: RealtimeSocketFactory);
    /** Connect and resolve only after the upstream session accepts its configuration. */
    connect(): Promise<void>;
    appendAudio(pcm: Uint8Array): void;
    commitAudio(): void;
    cancelResponse(): void;
    /** Feed a completed durable DSH turn back into the short-lived voice context and speak it once. */
    announceAgentResult(text: string, eventSeq: number): void;
    close(): void;
    private handleEvent;
    private finishTools;
    private drainAgentAnnouncements;
    private requestResponse;
    private send;
}
