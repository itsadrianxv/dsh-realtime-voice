export interface LocalVadOptions {
    rmsThreshold: number;
    peakThreshold: number;
    attackFrames: number;
    releaseFrames: number;
}
/** Small browser-side onset detector used only to stop playback before the cloud VAD round trip. */
export declare class LocalVoiceActivityDetector {
    private readonly options;
    private hotFrames;
    private quietFrames;
    private active;
    constructor(options?: LocalVadOptions);
    push(pcm: ArrayBuffer): boolean;
    reset(): void;
}
