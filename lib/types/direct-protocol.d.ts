import { VOICE_DIRECT_PROTOCOL, type VoiceApproval, type VoiceClientPlatform, type VoiceOccupancyStatus, type VoiceQuestion, type VoiceQuestionAnswer } from './protocol.ts';
export { VOICE_DIRECT_PROTOCOL };
export declare const VOICE_DIRECT_ROUTE: "/plugins/realtime-voice/v2/control";
export declare const VOICE_DIRECT_STATUS_ROUTE: "/plugins/realtime-voice/v2/status";
export declare const VOICE_DIRECT_BOOTSTRAP: "dsh.voice.bootstrap.v1";
export declare const VOICE_DIRECT_TRANSCRIPT: "dsh.voice.transcript.v1";
export declare const DIRECT_FUNCTION_ARGUMENT_MAX_BYTES: number;
export declare const DIRECT_TRANSCRIPT_MAX_ITEMS = 16;
export declare const DIRECT_TRANSCRIPT_MAX_TEXT_CHARS = 4000;
export declare const DIRECT_TRANSCRIPT_MAX_BYTES: number;
export declare const DIRECT_DSH_FUNCTION_NAMES: readonly ["handoff_to_dsh_agent", "cancel_dsh_agent", "answer_dsh_approval", "answer_dsh_question"];
export type DirectDshFunctionName = typeof DIRECT_DSH_FUNCTION_NAMES[number];
export interface DirectVoiceHello {
    type: 'voice.hello';
    protocol: typeof VOICE_DIRECT_PROTOCOL;
    /** Absence is backward-compatible connect behavior. */
    intent?: 'connect' | 'release';
    requestId: string;
    client: {
        platform: VoiceClientPlatform;
        version: string;
        foregroundOnly: boolean;
        /** Native/mini-program sockets can set Authorization; browser WebSocket cannot. */
        websocketAuthorizationHeader: boolean;
    };
    target: {
        sessionId: string;
    };
    resume?: {
        voiceSessionId: string;
        lastServerSeq: number;
        lastBackendEventSeq: number;
        transcriptCheckpoint?: DirectTranscriptCheckpoint;
    };
}
export interface DirectTranscriptCheckpoint {
    version: typeof VOICE_DIRECT_TRANSCRIPT;
    /** Final text only, ordered oldest to newest. */
    items: DirectTranscriptItem[];
}
export interface DirectTranscriptItem {
    role: 'user' | 'assistant';
    text: string;
    final: true;
}
export type DirectTranscriptHistoryEvent = {
    type: 'conversation.item.create';
    previous_item_id?: string;
    item: {
        id: string;
        type: 'message';
        role: 'user';
        content: [{
            type: 'input_text';
            text: string;
        }];
    } | {
        id: string;
        type: 'message';
        role: 'assistant';
        content: [{
            type: 'output_text';
            text: string;
        }];
    };
};
export interface DirectMediaOffer {
    offerId: string;
    transport: 'websocket';
    endpoint: string;
    authorization: {
        scheme: 'Bearer';
        temporaryBearer: string;
        expiresAt: number;
        authenticationPhase: 'handshake-only';
    };
    model: string;
    voice: string;
    audio: {
        input: {
            encoding: 'pcm_s16le';
            sampleRate: 16_000;
            channels: 1;
            recommendedChunkDurationMs: 32;
        };
        output: {
            encoding: 'pcm_s16le';
            sampleRate: 24_000;
            channels: 1;
            providerDeltaFraming: 'variable';
        };
    };
    bootstrap: {
        version: typeof VOICE_DIRECT_BOOTSTRAP;
        event: {
            type: 'session.update';
            session: {
                modalities: ['text', 'audio'];
                voice: string;
                instructions: string;
                input_audio_format: 'pcm';
                output_audio_format: 'pcm';
                max_history_turns: number;
                tools: readonly DirectFunctionTool[];
                turn_detection: {
                    type: 'server_vad';
                    threshold: number;
                    silence_duration_ms: number;
                } | {
                    type: 'smart_turn';
                };
            };
        };
        transcript?: {
            version: typeof VOICE_DIRECT_TRANSCRIPT;
            applyAfter: 'session.updated';
            acknowledgement: 'conversation.item.created';
            completeBefore: 'media.connected';
            events: DirectTranscriptHistoryEvent[];
        };
    };
}
export interface DirectFunctionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface DirectClientMetrics {
    capturedFrames?: number;
    playedFrames?: number;
    droppedFrames?: number;
    providerRttMs?: number;
    uplinkJitterMs?: number;
    downlinkJitterMs?: number;
}
export type DirectVoiceClientControl = DirectVoiceHello | {
    type: 'voice.end';
    reason?: string;
} | {
    type: 'voice.ping';
    sentAt: number;
} | {
    type: 'media.refresh';
    previousOfferId: string;
    reason: 'expiring' | 'reconnect';
} | {
    type: 'media.connected';
    offerId: string;
    mediaSessionId: string;
    connectedAt: number;
} | {
    type: 'media.closed';
    offerId: string;
    mediaSessionId: string;
    code?: number;
    reason?: string;
} | {
    type: 'provider.function-call';
    offerId: string;
    mediaSessionId: string;
    callId: string;
    name: string;
    arguments: string;
} | {
    type: 'voice.backend-ack';
    eventId: string;
    eventSeq: number;
} | {
    type: 'voice.approval-answer';
    approvalId: string;
    outcome: 'allowed-once' | 'rejected';
} | {
    type: 'voice.question-answer';
    requestId: string;
    answers: VoiceQuestionAnswer[];
} | {
    type: 'client.metrics';
    offerId?: string;
    mediaSessionId?: string;
    values: DirectClientMetrics;
};
export type DirectVoiceServerControl = {
    type: 'voice.ready';
    protocol: typeof VOICE_DIRECT_PROTOCOL;
    voiceSessionId: string;
    serverSeq: number;
    target: {
        sessionId: string;
        running: boolean;
    };
    capabilities: {
        directMedia: true;
        reconnect: true;
        functionBridge: true;
        backendEventAck: true;
        rawAudioOnControl: false;
        transcriptCheckpoint: {
            version: typeof VOICE_DIRECT_TRANSCRIPT;
            maxItems: typeof DIRECT_TRANSCRIPT_MAX_ITEMS;
            maxTextChars: typeof DIRECT_TRANSCRIPT_MAX_TEXT_CHARS;
            maxBytes: typeof DIRECT_TRANSCRIPT_MAX_BYTES;
            completedTurnsOnly: true;
        };
        resumeRelease: true;
    };
    mediaOffer: DirectMediaOffer;
} | {
    type: 'voice.busy';
    serverSeq: number;
    occupancy: VoiceOccupancyStatus;
} | {
    type: 'media.offer';
    serverSeq: number;
    mediaOffer: DirectMediaOffer;
} | {
    type: 'media.state';
    serverSeq: number;
    offerId: string;
    mediaSessionId?: string;
    state: 'connected' | 'closed';
} | {
    type: 'provider.function-result';
    serverSeq: number;
    offerId: string;
    mediaSessionId: string;
    callId: string;
    output: unknown;
    cached: boolean;
} | {
    type: 'voice.backend-event';
    serverSeq: number;
    eventId: string;
    eventSeq: number;
    kind: DirectBackendEventKind;
    text: string;
} | {
    type: 'voice.agent-status';
    serverSeq: number;
    sessionId: string;
    running: boolean;
    summary?: string;
} | {
    type: 'voice.approval';
    serverSeq: number;
    sessionId: string;
    status: 'pending' | 'resolved';
    approval: VoiceApproval;
    outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
} | {
    type: 'voice.question';
    serverSeq: number;
    sessionId: string;
    status: 'pending' | 'resolved';
    question: VoiceQuestion;
    outcome?: 'answered' | 'cancelled';
} | {
    type: 'voice.pong';
    serverSeq: number;
    sentAt: number;
} | {
    type: 'voice.error';
    serverSeq: number;
    code: string;
    message: string;
    recoverable: boolean;
} | {
    type: 'voice.ended';
    serverSeq: number;
    reason: string;
};
export type DirectBackendEventKind = 'status' | 'complete' | 'failed' | 'cancelled' | 'needs-approval' | 'needs-input';
export declare function isDirectVoiceClientControl(value: unknown): value is DirectVoiceClientControl;
export declare function isDirectTranscriptCheckpoint(value: unknown): value is DirectTranscriptCheckpoint;
export declare function isDirectDshFunctionName(value: unknown): value is DirectDshFunctionName;
export declare function isDirectFunctionArguments(name: DirectDshFunctionName, value: string): boolean;
