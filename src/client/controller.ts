import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AUDIO_CHANNELS,
  AudioFrameKind,
  decodeAudioFrame,
  encodeAudioFrame,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  VOICE_PROTOCOL,
  VOICE_ROUTE,
  type VoicePhase,
  type VoiceServerControl,
} from '../protocol.ts'
import { BrowserAudioEngine } from './audio-engine.ts'

export type ClientVoicePhase = 'idle' | 'requesting-permission' | VoicePhase | 'error'

export interface VoiceSnapshot {
  phase: ClientVoicePhase
  sessionId?: string
  voiceSessionId?: string
  muted: boolean
  userTranscript: string
  assistantTranscript: string
  agentRunning: boolean
  agentSummary?: string
  elapsedSeconds: number
  error?: string | undefined
}

const INITIAL_SNAPSHOT: VoiceSnapshot = {
  phase: 'idle',
  muted: false,
  userTranscript: '',
  assistantTranscript: '',
  agentRunning: false,
  elapsedSeconds: 0,
}

/** Root-lifetime call controller shared by the session button and frame overlay through inject hooks. */
export class VoiceCallController implements HostObservable<VoiceSnapshot> {
  private snapshot: VoiceSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | undefined
  private audio: BrowserAudioEngine | undefined
  private inputSequence = 0
  private inputStreamId = 1
  private providerReady = false
  private startedAt = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private ending = false

  getSnapshot = (): VoiceSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(sessionId: string): Promise<void> {
    if (this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'error') return
    if (!window.isSecureContext || navigator.mediaDevices?.getUserMedia === undefined) {
      this.update({ ...INITIAL_SNAPSHOT, phase: 'error', error: '实时语音需要安全上下文：请使用 localhost 或 HTTPS。' })
      return
    }
    this.ending = false
    this.reconnectAttempt = 0
    this.update({ ...INITIAL_SNAPSHOT, phase: 'requesting-permission', sessionId })
    try {
      const audio = new BrowserAudioEngine(pcm => this.sendAudio(pcm))
      this.audio = audio
      await audio.start()
      this.startedAt = Date.now()
      this.timer = setInterval(() => this.tick(), 1000)
      await this.connect(sessionId)
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  async end(): Promise<void> {
    if (this.snapshot.phase === 'idle') return
    this.ending = true
    this.update({ ...this.snapshot, phase: 'ending' })
    this.sendControl({ type: 'voice.end', reason: 'user-ended' })
    await this.cleanup()
    this.update(INITIAL_SNAPSHOT)
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted
    this.audio?.setMuted(muted)
    this.update({ ...this.snapshot, muted })
  }

  cancelResponse(): void {
    this.sendControl({ type: 'voice.cancel-response' })
  }

  async dispose(): Promise<void> {
    this.ending = true
    await this.cleanup()
    this.listeners.clear()
  }

  private async connect(sessionId: string): Promise<void> {
    this.update({ ...this.snapshot, phase: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting' })
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${scheme}//${location.host}${VOICE_ROUTE}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'voice.hello',
          protocol: VOICE_PROTOCOL,
          requestId: crypto.randomUUID(),
          client: {
            platform: 'web',
            version: '0.1.0',
            binaryWebSocket: true,
            playbackClear: true,
            pcmS16leVerified: true,
            foregroundOnly: false,
            duplex: 'full',
          },
          target: { sessionId },
          audio: {
            input: { encoding: 'pcm_s16le', sampleRate: INPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
            output: { encoding: 'pcm_s16le', sampleRate: OUTPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
          },
          ...(this.snapshot.voiceSessionId === undefined
            ? {}
            : { resume: { voiceSessionId: this.snapshot.voiceSessionId, lastServerSeq: 0 } }),
        }))
      }
      socket.onmessage = event => this.receive(event)
      socket.onerror = () => reject(new Error('无法连接 DSH 实时语音插件。'))
      const ready = (event: MessageEvent): void => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as VoiceServerControl
        if (message.type === 'voice.ready') {
          socket.removeEventListener('message', ready)
          this.providerReady = true
          this.reconnectAttempt = 0
          resolve()
        }
        if (message.type === 'voice.error' && !message.recoverable) {
          socket.removeEventListener('message', ready)
          reject(new Error(message.message))
        }
      }
      socket.addEventListener('message', ready)
      socket.onclose = () => {
        socket.removeEventListener('message', ready)
        this.providerReady = false
        if (!this.ending) this.scheduleReconnect(sessionId)
      }
    })
  }

  private receive(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      const frame = decodeAudioFrame(event.data)
      if (frame.kind === AudioFrameKind.ServerOutput) this.audio?.play(frame.payload, frame.streamId)
      return
    }
    if (typeof event.data !== 'string') return
    const message = JSON.parse(event.data) as VoiceServerControl
    switch (message.type) {
      case 'voice.ready':
        this.update({
          ...this.snapshot,
          phase: 'listening',
          voiceSessionId: message.voiceSessionId,
          agentRunning: message.target.running,
          error: undefined,
        })
        return
      case 'voice.state':
        this.update({ ...this.snapshot, phase: message.phase })
        return
      case 'voice.transcript':
        if (message.role === 'user') {
          this.update({ ...this.snapshot, userTranscript: message.text + (message.stash ?? '') })
        } else {
          this.update({ ...this.snapshot, assistantTranscript: message.text })
        }
        return
      case 'voice.playback-clear':
        this.audio?.clear(message.streamId)
        return
      case 'voice.agent-status':
        this.update({
          ...this.snapshot,
          agentRunning: message.running,
          ...(message.summary === undefined ? {} : { agentSummary: message.summary }),
        })
        return
      case 'voice.error':
        if (message.recoverable) {
          this.update({ ...this.snapshot, error: message.message })
        } else {
          void this.fail(message.message)
        }
        return
      case 'voice.ended':
        void this.end()
        return
      case 'voice.tool':
      case 'voice.pong':
        return
    }
  }

  private sendAudio(pcm: ArrayBuffer): void {
    const socket = this.socket
    if (!this.providerReady || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) return
    const sequence = this.inputSequence++
    socket.send(encodeAudioFrame(
      AudioFrameKind.ClientInput,
      this.inputStreamId,
      sequence,
      pcm,
      { ptsMs: sequence * 40 },
    ))
  }

  private sendControl(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private scheduleReconnect(sessionId: string): void {
    if (this.reconnectTimer !== undefined || this.ending) return
    if (this.reconnectAttempt >= 4) {
      void this.fail('实时语音连接多次重试失败，DSH 中已经开始的任务不会被取消。')
      return
    }
    const delay = 1000 * (2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.update({ ...this.snapshot, phase: 'reconnecting' })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect(sessionId).catch((error: unknown) => {
        if (!this.ending) this.scheduleReconnect(sessionId)
        if (error instanceof Error) this.update({ ...this.snapshot, error: error.message })
      })
    }, delay)
  }

  private tick(): void {
    if (this.startedAt === 0) return
    this.update({ ...this.snapshot, elapsedSeconds: Math.floor((Date.now() - this.startedAt) / 1000) })
  }

  private async fail(message: string): Promise<void> {
    this.ending = true
    await this.cleanup()
    this.update({ ...INITIAL_SNAPSHOT, phase: 'error', error: message })
  }

  private async cleanup(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.timer = undefined
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'voice client closed')
    await this.audio?.close()
    this.audio = undefined
    this.startedAt = 0
    this.providerReady = false
    this.inputSequence = 0
    this.inputStreamId += 1
  }

  private update(next: VoiceSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
