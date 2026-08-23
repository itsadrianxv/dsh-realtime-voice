import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type WebSocket from 'ws';
import type { VoiceConfig } from './config.ts';
import { VoiceRuntime, type VoiceContinuityState } from './voice-runtime.ts';
/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
export declare class VoiceConnection {
    private readonly ctx;
    private readonly socket;
    private readonly request;
    private readonly config;
    private readonly onClosed;
    private readonly runtime;
    private readonly provisionalId;
    private continuity;
    private serverSeq;
    private outputSeq;
    private outputStreamId;
    private outputPtsMs;
    private inputStreamId;
    private nextInputSequence;
    private hello;
    private provider;
    private session;
    private coordinator;
    private activeResponseId;
    private readonly suppressedResponses;
    private readonly handledFunctionCalls;
    private latestUserTranscript;
    private agentWorkPending;
    private closed;
    private ready;
    private helloTimer;
    private hostEventsAbort;
    private readonly pendingAssistantByTurn;
    constructor(ctx: Context, socket: WebSocket, request: IncomingMessage, config: VoiceConfig, onClosed: () => void, runtime?: VoiceRuntime);
    get id(): string;
    dispose(reason?: string): void;
    private receive;
    private start;
    private onProviderEvent;
    /** Execute only the small semantic bridge vocabulary exposed to Qwen. */
    private handleFunctionCall;
    private followDshEvents;
    private answerApproval;
    private answerQuestion;
    private sendApproval;
    private sendQuestion;
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
export declare function buildInstructions(status: {
    running: boolean;
    blank: boolean;
    cwd?: string;
    title?: string;
    summary?: string;
}, continuity?: Pick<VoiceContinuityState, 'userTranscript' | 'assistantTranscript'>): string;
