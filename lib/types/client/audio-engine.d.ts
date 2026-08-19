/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
export declare class BrowserAudioEngine {
    private readonly onInput;
    private context;
    private stream;
    private capture;
    private playback;
    private moduleUrl;
    constructor(onInput: (pcm: ArrayBuffer) => void);
    start(): Promise<void>;
    play(pcm: Uint8Array, epoch: number): void;
    clear(epoch: number): void;
    setMuted(muted: boolean): void;
    close(): Promise<void>;
}
