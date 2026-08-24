/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
export declare class BrowserAudioEngine {
    private readonly onInput;
    private readonly onSpeechStart;
    private readonly onPlaybackDrained;
    private context;
    private stream;
    private capture;
    private playback;
    private moduleUrl;
    private playbackEpoch;
    private readonly localVad;
    constructor(onInput: (pcm: ArrayBuffer) => void, onSpeechStart?: () => void, onPlaybackDrained?: (streamId: number) => void);
    start(): Promise<void>;
    play(pcm: Uint8Array, epoch: number): void;
    clear(epoch: number): void;
    finalize(epoch: number): void;
    /** Synchronous local barge-in; Host will confirm the same next stream epoch. */
    interruptPlayback(): void;
    setMuted(muted: boolean): void;
    close(): Promise<void>;
}
