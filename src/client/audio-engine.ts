import { AUDIO_CHANNELS, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from '../protocol.ts'
import { AUDIO_WORKLET_SOURCE } from './audio-worklet-source.ts'
import { LocalVoiceActivityDetector } from './local-vad.ts'

/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
export class BrowserAudioEngine {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private capture: AudioWorkletNode | undefined
  private playback: AudioWorkletNode | undefined
  private moduleUrl: string | undefined
  private playbackEpoch = 0
  private readonly localVad = new LocalVoiceActivityDetector()

  constructor(
    private readonly onInput: (pcm: ArrayBuffer) => void,
    private readonly onSpeechStart: () => void = () => {},
    private readonly onPlaybackDrained: (streamId: number) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: AUDIO_CHANNELS,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const context = new AudioContext({ latencyHint: 'interactive' })
    this.context = context
    this.moduleUrl = URL.createObjectURL(new Blob([AUDIO_WORKLET_SOURCE], { type: 'text/javascript' }))
    await context.audioWorklet.addModule(this.moduleUrl)
    const source = context.createMediaStreamSource(this.stream)
    const capture = new AudioWorkletNode(context, 'dsh-voice-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetSampleRate: INPUT_SAMPLE_RATE, frameSamples: 640 },
    })
    const silent = context.createGain()
    silent.gain.value = 0
    source.connect(capture)
    capture.connect(silent).connect(context.destination)
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.localVad.push(event.data)) this.onSpeechStart()
      this.onInput(event.data)
    }
    this.capture = capture
    const playback = new AudioWorkletNode(context, 'dsh-voice-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceSampleRate: OUTPUT_SAMPLE_RATE },
    })
    playback.connect(context.destination)
    playback.port.onmessage = (event: MessageEvent<{ type?: string; epoch?: number }>) => {
      if (event.data.type === 'drained' && typeof event.data.epoch === 'number') {
        this.onPlaybackDrained(event.data.epoch)
      }
    }
    this.playback = playback
    await context.resume()
  }

  play(pcm: Uint8Array, epoch: number): void {
    this.playbackEpoch = Math.max(this.playbackEpoch, epoch)
    const transferable = pcm.slice().buffer
    this.playback?.port.postMessage({ type: 'audio', epoch, pcm: transferable }, [transferable])
  }

  clear(epoch: number): void {
    this.playbackEpoch = epoch
    this.playback?.port.postMessage({ type: 'clear', epoch })
  }

  finalize(epoch: number): void {
    this.playback?.port.postMessage({ type: 'finalize', epoch })
  }

  /** Synchronous local barge-in; Host will confirm the same next stream epoch. */
  interruptPlayback(): void {
    this.clear(this.playbackEpoch + 1)
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  async close(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.capture?.disconnect()
    this.playback?.disconnect()
    this.capture = undefined
    this.playback = undefined
    this.playbackEpoch = 0
    this.localVad.reset()
    if (this.context !== undefined && this.context.state !== 'closed') await this.context.close()
    this.context = undefined
    if (this.moduleUrl !== undefined) URL.revokeObjectURL(this.moduleUrl)
    this.moduleUrl = undefined
  }
}
