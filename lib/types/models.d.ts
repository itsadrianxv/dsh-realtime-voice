/** Realtime voice models supported by the built-in DashScope provider. */
export declare const REALTIME_VOICE_MODELS: {
    readonly flash: "qwen-audio-3.0-realtime-flash";
    readonly plus: "qwen-audio-3.0-realtime-plus";
};
export type RealtimeVoiceModel = typeof REALTIME_VOICE_MODELS[keyof typeof REALTIME_VOICE_MODELS];
export declare const DEFAULT_REALTIME_VOICE_MODEL: RealtimeVoiceModel;
export declare const REALTIME_VOICE_SETTINGS_NAMESPACE: "realtime-voice";
export declare function isRealtimeVoiceModel(value: unknown): value is RealtimeVoiceModel;
export declare function realtimeVoiceModelLabel(model: string | undefined): string;
