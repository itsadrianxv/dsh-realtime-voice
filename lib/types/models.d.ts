/** Realtime voice models supported by the built-in DashScope provider. */
export declare const REALTIME_VOICE_MODELS: {
    readonly flash: "qwen-audio-3.0-realtime-flash";
    readonly plus: "qwen-audio-3.0-realtime-plus";
};
export type RealtimeVoiceModel = typeof REALTIME_VOICE_MODELS[keyof typeof REALTIME_VOICE_MODELS];
export declare const REALTIME_VOICE_TURN_DETECTION: {
    readonly fast: "server_vad";
    readonly semantic: "smart_turn";
};
export type RealtimeVoiceTurnDetection = typeof REALTIME_VOICE_TURN_DETECTION[keyof typeof REALTIME_VOICE_TURN_DETECTION];
export declare const DEFAULT_REALTIME_VOICE_MODEL: RealtimeVoiceModel;
export declare const DEFAULT_REALTIME_VOICE_TURN_DETECTION: RealtimeVoiceTurnDetection;
export declare const REALTIME_VOICE_SETTINGS_NAMESPACE: "realtime-voice";
export declare function isRealtimeVoiceModel(value: unknown): value is RealtimeVoiceModel;
export declare function isRealtimeVoiceTurnDetection(value: unknown): value is RealtimeVoiceTurnDetection;
export declare function realtimeVoiceModelLabel(model: string | undefined): string;
export declare function realtimeVoiceTurnDetectionLabel(mode: string | undefined): string;
