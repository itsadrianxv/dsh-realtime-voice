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
  type VoiceApproval,
  type VoicePhase,
  type VoiceQuestion,
  type VoiceQuestionAnswer,
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
  pendingApproval?: VoiceApproval
  pendingQuestion?: VoiceQuestion
  providerModel?: string
  turnDetection?: 'server_vad' | 'smart_turn'
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
  private connectionEpoch = 0
  private lastReconnectError: string | undefined
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
    this.lastReconnectError = undefined
    this.update({ ...INITIAL_SNAPSHOT, phase: 'requesting-permission', sessionId })
    try {
      const audio = new BrowserAudioEngine(
        pcm => this.sendAudio(pcm),
        () => this.handleLocalSpeechStart(),
      )
      this.audio = audio
      await audio.start()
      this.startedAt = Date.now()
      this.timer = setInterval(() => this.tick(), 1000)
      await this.connect(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.reconnectTimer !== undefined) {
        this.update({ ...this.snapshot, error: message })
      } else {
        await this.fail(message)
      }
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
    this.audio?.interruptPlayback()
    this.sendControl({ type: 'voice.cancel-response' })
  }

  answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): void {
    if (this.snapshot.pendingApproval?.approvalId !== approvalId) return
    this.sendControl({ type: 'voice.approval-answer', approvalId, outcome })
  }

  answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): void {
    if (this.snapshot.pendingQuestion?.requestId !== requestId || answers.length === 0) return
    this.sendControl({ type: 'voice.question-answer', requestId, answers })
  }

  async dispose(): Promise<void> {
    this.ending = true
    await this.cleanup()
    this.listeners.clear()
  }

  private async connect(sessionId: string): Promise<void> {
    const epoch = ++this.connectionEpoch
    const previous = this.socket
    this.socket = undefined
    if (previous !== undefined && previous.readyState < WebSocket.CLOSING) {
      previous.close(1000, 'voice-connection-superseded')
    }
    this.update({ ...this.snapshot, phase: this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting' })
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${scheme}//${location.host}${VOICE_ROUTE}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const readyTimeout = setTimeout(() => {
        if (this.socket !== socket || epoch !== this.connectionEpoch) return
        this.lastReconnectError = '等待实时语音服务就绪超时。'
        this.scheduleReconnect(sessionId)
        if (socket.readyState < WebSocket.CLOSING) socket.close(4000, 'voice-ready-timeout')
        if (!settled) {
          settled = true
          reject(new Error(this.lastReconnectError))
        }
      }, 25_000)
      const rejectOnce = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(readyTimeout)
        reject(error)
      }
      socket.onopen = () => {
        if (this.socket !== socket || epoch !== this.connectionEpoch) return
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
      socket.onmessage = (event) => {
        if (this.socket === socket && epoch === this.connectionEpoch) this.receive(event)
      }
      socket.onerror = () => {
        if (this.socket !== socket || epoch !== this.connectionEpoch) return
        this.lastReconnectError = '无法连接 DSH 实时语音插件。'
        this.scheduleReconnect(sessionId)
        rejectOnce(new Error(this.lastReconnectError))
      }
      const ready = (event: MessageEvent): void => {
        if (this.socket !== socket || epoch !== this.connectionEpoch) return
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as VoiceServerControl
        if (message.type === 'voice.ready') {
          socket.removeEventListener('message', ready)
          clearTimeout(readyTimeout)
          this.providerReady = true
          this.reconnectAttempt = 0
          this.lastReconnectError = undefined
          if (!settled) {
            settled = true
            resolve()
          }
        }
        if (message.type === 'voice.error' && !message.recoverable) {
          socket.removeEventListener('message', ready)
          this.lastReconnectError = message.message
          this.scheduleReconnect(sessionId)
          rejectOnce(new Error(message.message))
        }
      }
      socket.addEventListener('message', ready)
      socket.onclose = (event) => {
        clearTimeout(readyTimeout)
        socket.removeEventListener('message', ready)
        if (this.socket !== socket || epoch !== this.connectionEpoch) return
        this.socket = undefined
        this.providerReady = false
        // A new Host connection restarts its output stream ids at 1. Reset the
        // AudioWorklet epoch so it does not discard the recovered call as stale.
        this.audio?.clear(0)
        const reason = event.reason.trim()
        if (this.lastReconnectError === undefined || reason !== 'provider-disconnected') {
          this.lastReconnectError = reason === ''
            ? `实时语音连接关闭（代码 ${event.code}）。`
            : `实时语音连接关闭（代码 ${event.code}：${reason}）。`
        }
        if (!this.ending) this.scheduleReconnect(sessionId)
        rejectOnce(new Error(this.lastReconnectError))
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
          providerModel: message.provider.model,
          turnDetection: message.provider.turnDetection,
          agentRunning: message.target.running,
          error: undefined,
        })
        return
      case 'voice.state':
        this.update({
          ...this.snapshot,
          phase: message.phase,
          ...(message.phase === 'thinking' && this.snapshot.phase !== 'thinking'
            ? { assistantTranscript: '' }
            : {}),
        })
        return
      case 'voice.transcript':
        if (message.role === 'user') {
          this.update({ ...this.snapshot, userTranscript: message.text + (message.stash ?? '') })
        } else {
          this.update({
            ...this.snapshot,
            assistantTranscript: message.final
              ? message.text
              : this.snapshot.assistantTranscript + message.text,
          })
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
      case 'voice.approval':
        if (message.status === 'pending') {
          this.update({ ...this.snapshot, pendingApproval: message.approval })
        } else {
          const { pendingApproval: _pendingApproval, ...withoutApproval } = this.snapshot
          this.update(withoutApproval)
        }
        return
      case 'voice.question':
        if (message.status === 'pending') {
          this.update({ ...this.snapshot, pendingQuestion: message.question })
        } else {
          const { pendingQuestion: _pendingQuestion, ...withoutQuestion } = this.snapshot
          this.update(withoutQuestion)
        }
        return
      case 'voice.error':
        if (message.recoverable) {
          this.lastReconnectError = message.message
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
    if (this.reconnectAttempt >= 8) {
      const detail = this.lastReconnectError === undefined ? '' : ` 最后原因：${this.lastReconnectError}`
      void this.fail(`实时语音连接多次重试失败，DSH 中已经开始的任务不会被取消。${detail}`)
      return
    }
    const rateLimited = /rate.?limit|限流|代码\s*1007/i.test(this.lastReconnectError ?? '')
    const delay = rateLimited
      ? Math.min(60_000, 15_000 * (2 ** this.reconnectAttempt))
      : Math.min(30_000, 1000 * (2 ** this.reconnectAttempt))
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

  /** Stop audible output before the server-side VAD event completes its round trip. */
  private handleLocalSpeechStart(): void {
    if (this.snapshot.phase !== 'speaking'
      || this.snapshot.muted
      || this.snapshot.turnDetection !== 'server_vad') return
    this.audio?.interruptPlayback()
    this.sendControl({ type: 'voice.cancel-response' })
    this.update({ ...this.snapshot, phase: 'listening' })
  }

  private async fail(message: string): Promise<void> {
    this.ending = true
    await this.cleanup()
    this.update({ ...INITIAL_SNAPSHOT, phase: 'error', error: message })
  }

  private async cleanup(): Promise<void> {
    this.connectionEpoch += 1
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
