import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type WebSocket from 'ws';
import { type VoiceHello, type VoiceReady } from '../protocol.ts';
import type { VoiceConfig } from './config.ts';
import { VoiceRuntime, type VoiceContinuityState } from './voice-runtime.ts';
/** One client-neutral voice call, pinned to one DSH session for its full lifetime. */
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
    /** Compatibility gate for clients that did not negotiate local correlated
     * echo filtering. Capable clients keep forwarding near-end speech/pre-roll. */
    private suppressInputDuringPlayback;
    private gatedOutputStreamId;
    private readonly responseStreams;
    private readonly responseLastSequences;
    private readonly responseAudioDurationMs;
    private readonly responseAudioStartedAt;
    private readonly outputPacketizer;
    private browserAudioSendTail;
    private browserAudioGeneration;
    private queuedBrowserAudioBytes;
    private browserAudioTransportFailed;
    private playbackDrainFallbackTimer;
    private readonly suppressedResponses;
    private readonly handledFunctionCalls;
    private latestUserTranscript;
    private agentWorkPending;
    private dshTurnRunning;
    private activeDshJobs;
    private closed;
    private ready;
    private leaseAcquired;
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
    /**
     * Fold durable history after the live mux subscription is open. This closes
     * the provider-connect/reconnect gap without replaying already-terminal
     * handoffs: coordinator transitions are idempotent and scoped by prompt rpcId.
     */
    private reconcileDshHistory;
    private answerApproval;
    private answerQuestion;
    private sendApproval;
    private sendQuestion;
    /** Emit one protocol PCM packet and advance the cursor only for that packet. */
    private emitOutputPacket;
    /** Serialize binary sends so response finalization cannot overtake PCM. */
    private enqueueBrowserAudio;
    private sendBrowserAudioFrame;
    private failBrowserAudio;
    private failProviderAudio;
    private clearPlayback;
    private shouldGateInputDuringPlayback;
    /**
     * V1 clients that do not acknowledge playback drain use an estimate of the
     * remaining local queue from delivered PCM and release with a safety margin,
     * so compatibility mode can reduce echo without ever permanently muting mic.
     */
    private schedulePlaybackFallback;
    private releasePlaybackGate;
    /** Stop one response exactly once, even when local and provider VAD race. */
    private interruptActiveResponse;
    private sendTranscript;
    private sendState;
    private refreshAgentWorkPending;
    private fail;
    private send;
    private nextSeq;
    private persistOutputCursor;
    private rpcId;
}
export declare function validateAudioNegotiation(hello: VoiceHello): void;
/** Deterministic negotiated PCM contract; input cadence belongs to the client. */
export declare function negotiateVoiceAudio(hello: VoiceHello, maxBinaryFrameBytes: number): VoiceReady['audio'];
/** Deterministic, platform-neutral hello → ready capability negotiation. */
export declare function negotiateVoiceCapabilities(hello: VoiceHello): VoiceReady['capabilities'];
export declare function buildInstructions(status: {
    running: boolean;
    blank: boolean;
    cwd?: string;
    title?: string;
    summary?: string;
}, continuity?: Pick<VoiceContinuityState, 'userTranscript' | 'assistantTranscript'>): string;
