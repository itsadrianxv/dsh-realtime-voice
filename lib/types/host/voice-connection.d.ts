import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type WebSocket from 'ws';
import type { VoiceConfig } from './config.ts';
/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
export declare class VoiceConnection {
    private readonly ctx;
    private readonly socket;
    private readonly request;
    private readonly config;
    private readonly onClosed;
    readonly id: `${string}-${string}-${string}-${string}-${string}`;
    private serverSeq;
    private outputSeq;
    private outputStreamId;
    private outputPtsMs;
    private inputStreamId;
    private nextInputSequence;
    private hello;
    private provider;
    private tools;
    private activeResponseId;
    private readonly suppressedResponses;
    private closed;
    private ready;
    private helloTimer;
    private hostEventsAbort;
    private readonly pendingAssistantByTurn;
    constructor(ctx: Context, socket: WebSocket, request: IncomingMessage, config: VoiceConfig, onClosed: () => void);
    dispose(reason?: string): void;
    private receive;
    private start;
    private onProviderEvent;
    private runTool;
    private followDshEvents;
    private clearPlayback;
    /** Stop one response exactly once, even when local and provider VAD race. */
    private interruptActiveResponse;
    private sendTranscript;
    private sendState;
    private fail;
    private send;
    private nextSeq;
    private rpcId;
}
