/** Versioned client-neutral wire contract shared by WebUI and WeChat Mini Program clients. */
export declare const VOICE_PROTOCOL: "dsh.voice.v1";
export declare const VOICE_DIRECT_PROTOCOL: "dsh.voice.direct.v1";
export type VoiceControlProtocol = typeof VOICE_PROTOCOL | typeof VOICE_DIRECT_PROTOCOL;
export declare const VOICE_PROTOCOL_VERSION: 1;
export declare const VOICE_ROUTE: "/plugins/realtime-voice/v1";
export declare const VOICE_STATUS_ROUTE: "/plugins/realtime-voice/v1/status";
export declare const VOICE_WEB_CLIENT_VERSION: "0.1.0-alpha.9";
export declare const INPUT_SAMPLE_RATE: 16000;
export declare const OUTPUT_SAMPLE_RATE: 24000;
export declare const AUDIO_CHANNELS: 1;
export declare const OUTPUT_FRAME_DURATION_MS: 40;
export declare const PCM_SAMPLE_BYTES: 2;
export declare const OUTPUT_FRAME_BYTES: number;
export declare const AUDIO_HEADER_BYTES: 24;
export type VoiceClientPlatform = 'web' | 'wechat-mini-program' | 'ios' | 'android' | 'unknown';
export type VoiceEchoControl = 'host-gated' | 'client-filtered-preroll';
export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'agent-working' | 'speaking' | 'reconnecting' | 'ending';
export interface PcmAudioSpec {
    encoding: 'pcm_s16le';
    sampleRate: number;
    channels: 1;
    frameDurationMs: number;
}
export interface VoiceHello {
    type: 'voice.hello';
    protocol: typeof VOICE_PROTOCOL;
    requestId: string;
    client: {
        platform: VoiceClientPlatform;
        version: string;
        binaryWebSocket: true;
        playbackClear: true;
        /** Native clients must only set this after a real-device PCM layout probe. */
        pcmS16leVerified: true;
        foregroundOnly: boolean;
        duplex: 'full' | 'best-effort' | 'turn-based';
        /** Whether this transport can ACK after its actual local player queue drains. */
        playbackDrainAck?: boolean;
        /** Absence is backward-compatible host-gated echo control. */
        echoControl?: VoiceEchoControl;
    };
    target: {
        sessionId: string;
    };
    audio: {
        input: PcmAudioSpec;
        output: PcmAudioSpec;
    };
    resume?: {
        voiceSessionId: string;
        lastServerSeq: number;
    };
}
export interface VoiceApproval {
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}
export interface VoiceQuestionOption {
    label: string;
    description?: string;
}
export interface VoiceQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: VoiceQuestionOption[];
    multiSelect?: boolean;
}
export interface VoiceQuestionAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
export interface VoiceQuestion {
    requestId: string;
    questions: VoiceQuestionItem[];
}
export type VoiceClientControl = VoiceHello | {
    type: 'voice.end';
    reason?: string;
} | {
    type: 'voice.cancel-response';
} | {
    type: 'voice.playback-drained';
    streamId: number;
} | {
    type: 'voice.commit';
} | {
    type: 'voice.approval-answer';
    approvalId: string;
    outcome: 'allowed-once' | 'rejected';
} | {
    type: 'voice.question-answer';
    requestId: string;
    answers: VoiceQuestionAnswer[];
} | {
    type: 'voice.ping';
    sentAt: number;
};
export interface VoiceReady {
    type: 'voice.ready';
    protocol: typeof VOICE_PROTOCOL;
    voiceSessionId: string;
    serverSeq: number;
    target: {
        sessionId: string;
        running: boolean;
    };
    provider: {
        id: 'dashscope';
        model: string;
        voice: string;
        turnDetection: 'server_vad' | 'smart_turn';
    };
    audio: {
        input: PcmAudioSpec;
        output: PcmAudioSpec;
        maxBinaryFrameBytes: number;
    };
    capabilities: {
        bargeIn: boolean;
        functionCalling: boolean;
        reconnect: true;
        persistentAgentTask: true;
        playbackDrainAck: boolean;
        echoControl: VoiceEchoControl;
    };
}
export interface VoiceOccupancyOwner {
    /** Actual owner mode; status.protocol remains the queried route contract. */
    controlProtocol?: VoiceControlProtocol;
    platform: VoiceClientPlatform;
    clientVersion: string;
    sessionId: string;
    startedAt: number;
    lastSeenAt: number;
}
export interface VoiceOccupancyStatus {
    protocol: VoiceControlProtocol;
    active: boolean;
    owner?: VoiceOccupancyOwner;
}
export type VoiceServerControl = VoiceReady | {
    type: 'voice.busy';
    serverSeq: number;
    occupancy: VoiceOccupancyStatus;
} | {
    type: 'voice.state';
    serverSeq: number;
    phase: VoicePhase;
} | {
    type: 'voice.transcript';
    serverSeq: number;
    role: 'user' | 'assistant';
    final: boolean;
    text: string;
    stash?: string;
} | {
    type: 'voice.playback-clear';
    serverSeq: number;
    streamId: number;
    reason: 'barge-in' | 'cancelled';
} | {
    type: 'voice.playback-finalize';
    serverSeq: number;
    streamId: number;
    lastSequence: number;
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
    type: 'voice.tool';
    serverSeq: number;
    callId: string;
    name: string;
    status: 'started' | 'completed' | 'failed';
    message?: string;
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
export declare const enum AudioFrameKind {
    ClientInput = 1,
    ServerOutput = 2
}
export declare const enum AudioFrameCodec {
    PcmS16Le = 1
}
export declare const enum AudioFrameFlags {
    None = 0,
    Discontinuity = 1,
    EndOfStream = 2
}
export interface DecodedAudioFrame {
    kind: AudioFrameKind;
    codec: AudioFrameCodec;
    flags: number;
    streamId: number;
    sequence: number;
    ptsMs: number;
    payload: Uint8Array;
}
/** Encode one ordered frame in network byte order for browsers and Mini Program ArrayBuffers. */
export declare function encodeAudioFrame(kind: AudioFrameKind, streamId: number, sequence: number, payload: ArrayBuffer | Uint8Array, metadata?: {
    ptsMs?: number;
    flags?: number;
}): ArrayBuffer;
/** Decode and validate a binary voice frame without retaining the caller's mutable view. */
export declare function decodeAudioFrame(data: ArrayBuffer | Uint8Array): DecodedAudioFrame;
/** Narrow an untrusted JSON value to the client control messages accepted by the Host. */
export declare function isVoiceClientControl(value: unknown): value is VoiceClientControl;
