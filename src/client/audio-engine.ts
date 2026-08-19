import { AUDIO_CHANNELS, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from '../protocol.ts'
import { AUDIO_WORKLET_SOURCE } from './audio-worklet-source.ts'

/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
export class BrowserAudioEngine {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined
  private capture: AudioWorkletNode | undefined
  private playback: AudioWorkletNode | undefined
  private moduleUrl: string | undefined

  constructor(private readonly onInput: (pcm: ArrayBuffer) => void) {}

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
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.onInput(event.data)
    this.capture = capture
    const playback = new AudioWorkletNode(context, 'dsh-voice-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceSampleRate: OUTPUT_SAMPLE_RATE },
    })
    playback.connect(context.destination)
    this.playback = playback
    await context.resume()
  }

  play(pcm: Uint8Array, epoch: number): void {
    const transferable = pcm.slice().buffer
    this.playback?.port.postMessage({ type: 'audio', epoch, pcm: transferable }, [transferable])
  }

  clear(epoch: number): void {
    this.playback?.port.postMessage({ type: 'clear', epoch })
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
    if (this.context !== undefined && this.context.state !== 'closed') await this.context.close()
    this.context = undefined
    if (this.moduleUrl !== undefined) URL.revokeObjectURL(this.moduleUrl)
    this.moduleUrl = undefined
  }
}
