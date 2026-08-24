import WebSocket, { type ClientOptions } from 'ws'
import type { VoiceConfig } from './config.ts'

const MAX_PROVIDER_AUDIO_BUFFERED_BYTES = 4 * 1024 * 1024

export interface DashScopeRealtimeCallbacks {
  onEvent: (event: DashScopeServerEvent) => void
}

export type DashScopeServerEvent = Record<string, unknown> & { type: string }
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket

interface VoiceAnnouncement {
  id: string
  text: string
}

export interface RealtimeFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * One upstream Qwen-Audio Realtime session. It remains the responsive
 * conversational surface and may semantically hand work to DSH through a
 * deliberately small Function Calling vocabulary.
 */
export class DashScopeRealtime {
  private socket: WebSocket | undefined
  private readonly queuedAnnouncements: VoiceAnnouncement[] = []
  private readonly announcedIds = new Set<string>()
  private responseActive = false
  private responseRequested = false
  private followupResponsePending = false
  private inputSpeechActive = false
  private automaticTurnPending = false
  private closed = false

  constructor(
    private readonly config: VoiceConfig,
    private readonly apiKey: string,
    private readonly instructions: string,
    private readonly tools: readonly RealtimeFunctionTool[],
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
                tools: this.tools,
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
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      throw new Error('DashScope input PCM must contain complete 16-bit samples')
    }
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('DashScope realtime socket is not open')
    if (this.socket.bufferedAmount > MAX_PROVIDER_AUDIO_BUFFERED_BYTES) {
      throw new Error('DashScope input audio buffer exceeded 4 MiB')
    }
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' })
  }

  /** Return a completed Function Call without blocking the live conversation. */
  completeFunctionCall(callId: string, output: unknown): void {
    if (this.closed) return
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
    this.requestResponseAfterCurrent()
  }

  /**
   * Inject an authoritative backend event into the Realtime conversation.
   * Qwen turns the tagged event into a short spoken update; it never treats it
   * as a fresh user task.
   */
  announceBackendEvent(id: string, text: string): void {
    this.queueAnnouncement(id, `[BACKEND]\n${text.slice(0, 4_000)}`)
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
      this.automaticTurnPending = true
      return
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.inputSpeechActive = false
      return
    }
    if (event.type === 'response.created') {
      this.responseActive = true
      this.responseRequested = false
      if (this.automaticTurnPending && !this.inputSpeechActive) this.automaticTurnPending = false
      return
    }
    if (event.type !== 'response.done') return
    this.responseActive = false
    this.responseRequested = false
    if (this.followupResponsePending) {
      if (this.inputSpeechActive || this.automaticTurnPending) return
      this.followupResponsePending = false
      this.requestResponse()
      return
    }
    this.drainAgentAnnouncements()
  }

  private drainAgentAnnouncements(): void {
    if (this.closed
      || this.inputSpeechActive
      || this.automaticTurnPending
      || this.responseActive
      || this.responseRequested
      || this.queuedAnnouncements.length === 0) return
    const announcement = this.queuedAnnouncements.shift()!
    this.send({
      type: 'conversation.item.create',
      item: {
        id: announcement.id,
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: announcement.text,
        }],
      },
    })
    this.requestResponse()
  }

  private requestResponse(): void {
    if (this.closed || this.responseActive || this.responseRequested || this.inputSpeechActive || this.automaticTurnPending) {
      this.followupResponsePending = true
      return
    }
    this.responseRequested = true
    this.send({ type: 'response.create' })
  }

  private requestResponseAfterCurrent(): void {
    if (this.responseActive || this.responseRequested || this.inputSpeechActive) {
      this.followupResponsePending = true
      return
    }
    this.requestResponse()
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
