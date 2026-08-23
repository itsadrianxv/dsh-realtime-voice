import WebSocket, { type ClientOptions } from 'ws'
import type { VoiceConfig } from './config.ts'

export interface DashScopeRealtimeCallbacks {
  onEvent: (event: DashScopeServerEvent) => void
}

export type DashScopeServerEvent = Record<string, unknown> & { type: string }
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket

interface VoiceAnnouncement {
  id: string
  text: string
}

/** One upstream Qwen-Audio Realtime session used only for speech I/O. */
export class DashScopeRealtime {
  private socket: WebSocket | undefined
  private readonly queuedAnnouncements: VoiceAnnouncement[] = []
  private readonly announcedIds = new Set<string>()
  private responseActive = false
  private responseRequested = false
  private inputSpeechActive = false
  private closed = false

  constructor(
    private readonly config: VoiceConfig,
    private readonly apiKey: string,
    private readonly instructions: string,
    private readonly callbacks: DashScopeRealtimeCallbacks,
    private readonly socketFactory: RealtimeSocketFactory = (url, options) => new WebSocket(url, options),
  ) {}

  /** Connect and resolve only after the upstream session accepts its configuration. */
  async connect(): Promise<void> {
    const url = new URL(this.config.endpoint)
    if (url.protocol !== 'wss:') throw new Error('DashScope realtime endpoint must use wss://')
    url.searchParams.set('model', this.config.model)
    const socket = this.socketFactory(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': '@harness-remote/dsh-realtime-voice',
      },
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('DashScope realtime connection timed out'))
        socket.close()
      }, this.config.connectTimeoutMs)
      let settled = false
      const fail = (error: Error): void => {
        clearTimeout(timeout)
        if (!settled) {
          settled = true
          reject(error)
        } else if (!this.closed) {
          this.emitEvent({ type: 'error', error: { type: 'transport_error', message: error.message } })
        }
      }
      socket.on('error', fail)
      socket.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString()) as DashScopeServerEvent
          if (event.type === 'session.created') {
            this.send({
              type: 'session.update',
              session: {
                modalities: ['text', 'audio'],
                voice: this.config.voice,
                instructions: this.instructions,
                input_audio_format: 'pcm',
                output_audio_format: 'pcm',
                max_history_turns: this.config.maxHistoryTurns,
                turn_detection: this.config.turnDetection === 'server_vad'
                  ? {
                      type: 'server_vad',
                      threshold: this.config.vadThreshold,
                      silence_duration_ms: this.config.silenceDurationMs,
                    }
                  : { type: 'smart_turn' },
              },
            })
          }
          if (event.type === 'session.updated') {
            clearTimeout(timeout)
            settled = true
            resolve()
          }
          this.handleEvent(event)
        } catch (error) {
          this.emitEvent({
            type: 'error',
            error: {
              type: 'provider_event_error',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
      socket.once('close', (code, reason) => {
        clearTimeout(timeout)
        if (!this.closed) this.emitEvent({
          type: 'transport.closed',
          code,
          reason: reason.toString(),
        })
      })
    })
  }

  appendAudio(pcm: Uint8Array): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' })
  }

  /** Feed a completed durable DSH turn back into the short-lived voice context and speak it once. */
  announceAgentResult(text: string, eventSeq: number): void {
    const id = `dsh_agent_${eventSeq}`
    this.queueAnnouncement(id, `DSH Agent 刚完成了一次工作。以下是 DSH 会话中的权威最终回复。请用自然、简短的中文主动向用户播报结果，不要重复提交任务：\n${text.slice(0, 2_000)}`)
  }

  private queueAnnouncement(id: string, text: string): void {
    if (this.closed || this.announcedIds.has(id)) return
    this.announcedIds.add(id)
    this.queuedAnnouncements.push({ id, text })
    if (this.queuedAnnouncements.length > 4) this.queuedAnnouncements.shift()
    this.drainAgentAnnouncements()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.close(1000, 'voice session closed')
    this.socket = undefined
  }

  private handleEvent(event: DashScopeServerEvent): void {
    this.emitEvent(event)
    if (event.type === 'input_audio_buffer.speech_started') {
      this.inputSpeechActive = true
      return
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.inputSpeechActive = false
      return
    }
    if (event.type === 'response.created') {
      this.responseActive = true
      this.responseRequested = false
      return
    }
    if (event.type !== 'response.done') return
    this.responseActive = false
    this.responseRequested = false
    this.drainAgentAnnouncements()
  }

  private drainAgentAnnouncements(): void {
    if (this.closed
      || this.inputSpeechActive
      || this.responseActive
      || this.responseRequested
      || this.queuedAnnouncements.length === 0) return
    const announcement = this.queuedAnnouncements.shift()!
    this.send({
      type: 'conversation.item.create',
      item: {
        id: announcement.id,
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: announcement.text,
        }],
      },
    })
    this.requestResponse()
  }

  private requestResponse(): void {
    this.responseRequested = true
    this.send({ type: 'response.create' })
  }

  /** A plugin callback must never be able to escape a ws EventEmitter turn and crash DSH. */
  private emitEvent(event: DashScopeServerEvent): void {
    try {
      this.callbacks.onEvent(event)
    } catch {
      // The browser-facing connection owns its own failure reporting. Swallow
      // callback faults here so one voice call cannot terminate the DSH host.
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('DashScope realtime socket is not open')
    this.socket.send(JSON.stringify(message))
  }
}
