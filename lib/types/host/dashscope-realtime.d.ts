import WebSocket, { type ClientOptions } from 'ws';
import type { VoiceConfig } from './config.ts';
export interface DashScopeRealtimeCallbacks {
    onEvent: (event: DashScopeServerEvent) => void;
}
export type DashScopeServerEvent = Record<string, unknown> & {
    type: string;
};
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket;
/** One upstream Qwen-Audio Realtime session used only for speech I/O. */
export declare class DashScopeRealtime {
    private readonly config;
    private readonly apiKey;
    private readonly instructions;
    private readonly callbacks;
    private readonly socketFactory;
    private socket;
    private readonly queuedAnnouncements;
    private readonly announcedIds;
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
    private queueAnnouncement;
    close(): void;
    private handleEvent;
    private drainAgentAnnouncements;
    private requestResponse;
    /** A plugin callback must never be able to escape a ws EventEmitter turn and crash DSH. */
    private emitEvent;
    private send;
}
