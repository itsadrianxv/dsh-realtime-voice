import WebSocket, { type ClientOptions } from 'ws';
import type { VoiceConfig } from './config.ts';
export interface DashScopeRealtimeCallbacks {
    onEvent: (event: DashScopeServerEvent) => void;
}
export type DashScopeServerEvent = Record<string, unknown> & {
    type: string;
};
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket;
export interface RealtimeFunctionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/**
 * One upstream Qwen-Audio Realtime session. It remains the responsive
 * conversational surface and may semantically hand work to DSH through a
 * deliberately small Function Calling vocabulary.
 */
export declare class DashScopeRealtime {
    private readonly config;
    private readonly apiKey;
    private readonly instructions;
    private readonly tools;
    private readonly callbacks;
    private readonly socketFactory;
    private socket;
    private readonly queuedAnnouncements;
    private readonly announcedIds;
    private responseActive;
    private responseRequested;
    private followupResponsePending;
    private inputSpeechActive;
    private closed;
    constructor(config: VoiceConfig, apiKey: string, instructions: string, tools: readonly RealtimeFunctionTool[], callbacks: DashScopeRealtimeCallbacks, socketFactory?: RealtimeSocketFactory);
    /** Connect and resolve only after the upstream session accepts its configuration. */
    connect(): Promise<void>;
    appendAudio(pcm: Uint8Array): void;
    commitAudio(): void;
    cancelResponse(): void;
    /** Return a completed Function Call without blocking the live conversation. */
    completeFunctionCall(callId: string, output: unknown): void;
    /**
     * Inject an authoritative backend event into the Realtime conversation.
     * Qwen turns the tagged event into a short spoken update; it never treats it
     * as a fresh user task.
     */
    announceBackendEvent(id: string, text: string): void;
    private queueAnnouncement;
    close(): void;
    private handleEvent;
    private drainAgentAnnouncements;
    private requestResponse;
    private requestResponseAfterCurrent;
    /** A plugin callback must never be able to escape a ws EventEmitter turn and crash DSH. */
    private emitEvent;
    private send;
}
