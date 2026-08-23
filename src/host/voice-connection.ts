import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type WebSocket from 'ws'
import {
  AUDIO_CHANNELS,
  AudioFrameKind,
  decodeAudioFrame,
  encodeAudioFrame,
  INPUT_SAMPLE_RATE,
  isVoiceClientControl,
  OUTPUT_SAMPLE_RATE,
  VOICE_PROTOCOL,
  type VoiceHello,
  type VoiceServerControl,
} from '../protocol.ts'
import type { VoiceConfig } from './config.ts'
import { DashScopeRealtime, type DashScopeServerEvent } from './dashscope-realtime.ts'
import { DshVoiceCoordinator } from './dsh-coordinator.ts'
import { assistantText, DshVoiceSession } from './dsh-session-state.ts'
import { isWebSocketSendError } from './websocket-send.ts'

/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
export class VoiceConnection {
  readonly id = randomUUID()
  private serverSeq = 0
  private outputSeq = 0
  private outputStreamId = 1
  private outputPtsMs = 0
  private inputStreamId: number | undefined
  private nextInputSequence = 0
  private hello: VoiceHello | undefined
  private provider: DashScopeRealtime | undefined
  private session: DshVoiceSession | undefined
  private coordinator: DshVoiceCoordinator | undefined
  private activeResponseId: string | undefined
  private readonly suppressedResponses = new Set<string>()
  private readonly providerUserResponses = new Set<string>()
  private awaitingProviderUserResponse = false
  private agentWorkPending = false
  private closed = false
  private ready = false
  private helloTimer: ReturnType<typeof setTimeout>
  private hostEventsAbort: AbortController | undefined
  private readonly pendingAssistantByTurn = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly socket: WebSocket,
    private readonly request: IncomingMessage,
    private readonly config: VoiceConfig,
    private readonly onClosed: () => void,
  ) {
    this.helloTimer = setTimeout(() => this.fail('hello-timeout', '客户端未及时发送 voice.hello。', false), 10_000)
    socket.on('message', (data, isBinary) => {
      void this.receive(data, isBinary).catch((error: unknown) => {
        this.fail(
          this.ready ? 'bad-client-message' : 'voice-start-failed',
          error instanceof Error ? error.message : String(error),
          this.ready,
        )
      })
    })
    socket.once('close', () => this.dispose('client-disconnected'))
    socket.once('error', () => this.dispose('client-error'))
  }

  dispose(reason = 'plugin-disposed'): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimer)
    this.hostEventsAbort?.abort()
    this.coordinator?.dispose()
    this.coordinator = undefined
    this.provider?.close()
    this.provider = undefined
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(1001, reason)
    }
    this.onClosed()
  }

  private async receive(raw: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return
    if (isBinary) {
      if (this.provider === undefined) throw new Error('audio arrived before voice.ready')
      const bytes = normalizeRawData(raw)
      if (bytes.byteLength > this.config.maxBinaryFrameBytes) throw new Error('audio frame exceeds the configured limit')
      const frame = decodeAudioFrame(bytes)
      if (frame.kind !== AudioFrameKind.ClientInput) throw new Error('client sent a non-input audio frame')
      if (frame.payload.byteLength === 0 || frame.payload.byteLength % 2 !== 0) {
        throw new Error('PCM input payload must contain complete 16-bit samples')
      }
      if (frame.streamId !== this.inputStreamId) {
        this.inputStreamId = frame.streamId
        this.nextInputSequence = frame.sequence
      }
      if (frame.sequence !== this.nextInputSequence) {
        if (frame.sequence < this.nextInputSequence) return
        throw new Error(`input audio sequence gap: expected ${this.nextInputSequence}, received ${frame.sequence}`)
      }
      this.nextInputSequence += 1
      this.provider.appendAudio(frame.payload)
      return
    }
    const parsed: unknown = JSON.parse(raw.toString())
    if (!isVoiceClientControl(parsed)) throw new Error('unknown voice control message')
    switch (parsed.type) {
      case 'voice.hello':
        if (this.hello !== undefined) throw new Error('voice.hello may only be sent once')
        await this.start(parsed)
        return
      case 'voice.end':
        this.send({ type: 'voice.ended', serverSeq: this.nextSeq(), reason: parsed.reason ?? 'client-ended' })
        this.dispose('client-ended')
        return
      case 'voice.cancel-response':
        this.interruptActiveResponse('cancelled', true)
        return
      case 'voice.commit':
        this.provider?.commitAudio()
        return
      case 'voice.ping':
        this.send({ type: 'voice.pong', serverSeq: this.nextSeq(), sentAt: parsed.sentAt })
        return
    }
  }

  private async start(hello: VoiceHello): Promise<void> {
    validateAudioNegotiation(hello)
    clearTimeout(this.helloTimer)
    this.hello = hello
    this.session = new DshVoiceSession(this.ctx, hello.target.sessionId)
    const status = await this.session.snapshot()
    const coordinator = new DshVoiceCoordinator(this.ctx, hello.target.sessionId, {
      onWorkerStarted: worker => this.send({
        type: 'voice.agent-status',
        serverSeq: this.nextSeq(),
        sessionId: worker.sessionId,
        running: true,
        ...(worker.title === undefined ? {} : { summary: worker.title }),
      }),
      onWorkerUpdated: worker => this.send({
        type: 'voice.agent-status',
        serverSeq: this.nextSeq(),
        sessionId: worker.sessionId,
        running: worker.running,
        ...(worker.title === undefined ? {} : { summary: worker.title }),
      }),
    })
    await coordinator.attach()
    this.coordinator = coordinator
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv))
    if (credential === undefined) {
      this.fail(
        'credential-missing',
        `未检测到 ${this.config.apiKeyEnv}。请打开“设置 → 插件 → DSH 实时语音”安全保存百炼 API Key，或在本机环境中配置同名变量。`,
        false,
      )
      return
    }
    const instructions = buildInstructions(status)
    const provider = new DashScopeRealtime(this.config, credential.value, instructions, {
      onEvent: event => this.onProviderEvent(event),
    })
    this.provider = provider
    await provider.connect()
    if (this.closed) return
    this.ready = true
    this.send({
      type: 'voice.ready',
      protocol: VOICE_PROTOCOL,
      voiceSessionId: this.id,
      serverSeq: this.nextSeq(),
      target: { sessionId: hello.target.sessionId, running: status.running },
      provider: {
        id: 'dashscope',
        model: this.config.model,
        voice: this.config.voice,
        turnDetection: this.config.turnDetection,
      },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: INPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        output: { encoding: 'pcm_s16le', sampleRate: OUTPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        maxBinaryFrameBytes: this.config.maxBinaryFrameBytes,
      },
      capabilities: { bargeIn: true, functionCalling: false, reconnect: true, persistentAgentTask: true },
    })
    this.sendState('listening')
    this.followDshEvents(hello.target.sessionId)
  }

  private onProviderEvent(event: DashScopeServerEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // Qwen has already detected this turn and automatically cancels the
        // active response. Only suppress/clear here; a second response.cancel
        // would race and can yield "Conversation has no active response".
        this.interruptActiveResponse('barge-in', false)
        this.sendState('listening')
        return
      case 'input_audio_buffer.speech_stopped':
        this.awaitingProviderUserResponse = true
        this.sendState('thinking')
        return
      case 'conversation.item.input_audio_transcription.delta':
        this.sendTranscript('user', false, field(event, 'text'), optionalField(event, 'stash'))
        return
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = field(event, 'transcript')
        this.sendTranscript('user', true, transcript)
        void this.submitUserTurn(transcript)
        return
      }
      case 'response.created': {
        const response = event.response as Record<string, unknown> | undefined
        this.activeResponseId = typeof response?.id === 'string' ? response.id : undefined
        if (this.activeResponseId !== undefined && this.awaitingProviderUserResponse) {
          this.awaitingProviderUserResponse = false
          this.providerUserResponses.add(this.activeResponseId)
        }
        this.sendState('thinking')
        return
      }
      case 'response.audio.delta': {
        const responseId = optionalField(event, 'response_id')
        const effectiveResponseId = responseId ?? this.activeResponseId
        if (effectiveResponseId !== undefined
          && (this.suppressedResponses.has(effectiveResponseId) || this.providerUserResponses.has(effectiveResponseId))) return
        const audio = Buffer.from(field(event, 'delta'), 'base64')
        const sequence = this.outputSeq++
        const frame = encodeAudioFrame(
          AudioFrameKind.ServerOutput,
          this.outputStreamId,
          sequence,
          audio,
          { ptsMs: Math.round(this.outputPtsMs) },
        )
        this.outputPtsMs += audio.byteLength / 2 / OUTPUT_SAMPLE_RATE * 1000
        if (this.socket.readyState !== this.socket.OPEN) return
        this.socket.send(frame, { binary: true }, (error) => {
          if (isWebSocketSendError(error) && !this.closed) this.dispose('browser-audio-send-failed')
        })
        this.sendState('speaking')
        return
      }
      case 'response.audio_transcript.delta':
        if (this.providerUserResponses.has(optionalField(event, 'response_id') ?? this.activeResponseId ?? '')) return
        this.sendTranscript('assistant', false, field(event, 'delta'))
        return
      case 'response.audio_transcript.done':
        if (this.providerUserResponses.has(optionalField(event, 'response_id') ?? this.activeResponseId ?? '')) return
        this.sendTranscript('assistant', true, field(event, 'transcript'))
        return
      case 'response.done': {
        const response = event.response as Record<string, unknown> | undefined
        const responseId = typeof response?.id === 'string' ? response.id : undefined
        if (responseId !== undefined) this.suppressedResponses.delete(responseId)
        if (responseId !== undefined) this.providerUserResponses.delete(responseId)
        this.activeResponseId = undefined
        this.sendState(this.agentWorkPending ? 'agent-working' : 'listening')
        return
      }
      case 'transport.closed':
        this.ctx.logger.warn(`[realtime-voice] DashScope closed: code=${String(event.code)} reason=${String(event.reason ?? '')}`)
        this.fail(
          'provider-disconnected',
          `百炼实时语音连接已断开（代码 ${String(event.code)}${event.reason === '' ? '' : `：${String(event.reason)}`}）。`,
          true,
        )
        this.dispose('provider-disconnected')
        return
      case 'error': {
        const error = event.error as Record<string, unknown> | undefined
        const message = typeof error?.message === 'string' ? error.message : '百炼实时语音服务返回错误。'
        if (/no active response/i.test(message) && this.suppressedResponses.size > 0) return
        this.ctx.logger.warn(`[realtime-voice] provider error: ${message}`)
        this.fail('provider-error', message, true)
        return
      }
    }
  }

  /** Send every semantic voice turn to the bound DSH Agent without intent classification. */
  private async submitUserTurn(transcript: string): Promise<void> {
    const text = transcript.trim()
    if (text === '' || this.closed) return
    const callId = `voice_turn_${randomUUID()}`
    this.send({ type: 'voice.tool', serverSeq: this.nextSeq(), callId, name: 'send_to_dsh_agent', status: 'started' })
    this.agentWorkPending = true
    this.sendState('agent-working')
    try {
      await this.coordinator!.submitUserTurn(text)
      this.send({
        type: 'voice.tool',
        serverSeq: this.nextSeq(),
        callId,
        name: 'send_to_dsh_agent',
        status: 'completed',
        message: '已进入当前 DSH Agent 会话。',
      })
    } catch (error) {
      this.agentWorkPending = false
      this.send({
        type: 'voice.tool',
        serverSeq: this.nextSeq(),
        callId,
        name: 'send_to_dsh_agent',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      this.sendState('listening')
    }
  }

  private followDshEvents(sessionId: string): void {
    const abort = new AbortController()
    this.hostEventsAbort = abort
    const request = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.host(request, abort.signal)) {
        const frame = item.payload
        if (frame.type === 'host/session-status'
          && (frame.sessionId === sessionId || this.coordinator?.isWorkerSession(frame.sessionId) === true)) {
          this.send({ type: 'voice.agent-status', serverSeq: this.nextSeq(), sessionId: frame.sessionId, running: frame.running })
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.ctx.logger.warn(error)
    })
    const muxRequest = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.mux(muxRequest, abort.signal)) {
        const frame = item.payload
        if (frame.type !== 'session/event') continue
        const isBoundSession = frame.sessionId === sessionId
        const isWorkerSession = this.coordinator?.isWorkerSession(frame.sessionId) === true
        if (!isBoundSession && !isWorkerSession) continue
        const event = frame.event
        if (event.type === 'assistant/message') {
          const data = event.data as Record<string, unknown>
          const turn = data.turn
          const text = assistantText(event)
          if (typeof turn === 'number' && text !== undefined) {
            this.pendingAssistantByTurn.set(`${frame.sessionId}:${turn}`, text)
          }
          continue
        }
        if (event.type !== 'turn/end') continue
        const data = event.data as Record<string, unknown>
        const turn = data.turn
        if (typeof turn !== 'number') continue
        const key = `${frame.sessionId}:${turn}`
        const text = this.pendingAssistantByTurn.get(key)
        this.pendingAssistantByTurn.delete(key)
        if (text === undefined) continue
        if (isWorkerSession) {
          this.send({
            type: 'voice.agent-status',
            serverSeq: this.nextSeq(),
            sessionId: frame.sessionId,
            running: false,
            summary: text.slice(0, 1_200),
          })
          this.agentWorkPending = true
          this.sendState('agent-working')
          void this.coordinator?.returnWorkerResult(frame.sessionId, text).catch((error: unknown) => {
            if (!abort.signal.aborted) this.ctx.logger.warn(`[realtime-voice] failed to return worker result: ${String(error)}`)
          })
          continue
        }
        this.agentWorkPending = false
        this.send({
          type: 'voice.agent-status',
          serverSeq: this.nextSeq(),
          sessionId,
          running: false,
          summary: text.slice(0, 1_200),
        })
        this.provider?.announceAgentResult(text, event.seq)
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.ctx.logger.warn(error)
    })
  }

  private clearPlayback(reason: 'barge-in' | 'cancelled'): void {
    this.outputStreamId += 1
    this.outputSeq = 0
    this.outputPtsMs = 0
    this.send({ type: 'voice.playback-clear', serverSeq: this.nextSeq(), streamId: this.outputStreamId, reason })
  }

  /** Stop one response exactly once, even when local and provider VAD race. */
  private interruptActiveResponse(reason: 'barge-in' | 'cancelled', cancelProvider: boolean): void {
    const responseId = this.activeResponseId
    if (responseId !== undefined) {
      if (this.suppressedResponses.has(responseId)) return
      this.suppressedResponses.add(responseId)
    }
    this.clearPlayback(reason)
    if (responseId === undefined || !cancelProvider) return
    try {
      this.provider?.cancelResponse()
    } catch (error) {
      this.ctx.logger.warn(`[realtime-voice] response cancellation raced with transport close: ${String(error)}`)
    }
  }

  private sendTranscript(role: 'user' | 'assistant', final: boolean, text: string, stash?: string): void {
    this.send({
      type: 'voice.transcript',
      serverSeq: this.nextSeq(),
      role,
      final,
      text,
      ...(stash === undefined ? {} : { stash }),
    })
  }

  private sendState(phase: 'listening' | 'thinking' | 'agent-working' | 'speaking'): void {
    this.send({ type: 'voice.state', serverSeq: this.nextSeq(), phase })
  }

  private fail(code: string, message: string, recoverable: boolean): void {
    this.send({ type: 'voice.error', serverSeq: this.nextSeq(), code, message, recoverable })
    if (!recoverable) this.dispose(code)
  }

  private send(message: VoiceServerControl): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private nextSeq(): number {
    this.serverSeq += 1
    return this.serverSeq
  }

  private rpcId() {
    return RpcId(randomUUID())
  }
}

function validateAudioNegotiation(hello: VoiceHello): void {
  if (hello.audio.input.encoding !== 'pcm_s16le'
    || hello.audio.input.sampleRate !== INPUT_SAMPLE_RATE
    || hello.audio.input.channels !== AUDIO_CHANNELS) {
    throw new Error('V1 input requires PCM s16le, 16 kHz, mono')
  }
  if (hello.audio.output.encoding !== 'pcm_s16le'
    || hello.audio.output.sampleRate !== OUTPUT_SAMPLE_RATE
    || hello.audio.output.channels !== AUDIO_CHANNELS) {
    throw new Error('V1 output requires PCM s16le, 24 kHz, mono')
  }
}

function normalizeRawData(raw: WebSocket.RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw))
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

export function buildInstructions(status: { running: boolean; blank: boolean; cwd?: string; title?: string; summary?: string }): string {
  return [
    '你是 DeepSeek Harness 的实时语音输入与播报层，不是负责回答或决策的 Agent。',
    '用户说话时只需忠实完成转写；不要回答、建议、拒绝、调用工具或输出任何语音和文字。用户的完整转写会由宿主直接送入绑定的 DSH Agent 会话。',
    '只有收到标记为“DSH Agent 刚完成”的系统上下文时才输出语音：忠实、简短、自然地播报其中的权威结果，不要添加新的判断，也不要再次提交任务。',
    `当前 DSH 状态：running=${String(status.running)}, blank=${String(status.blank)}.`,
    status.cwd === undefined ? '' : `当前项目目录：${status.cwd}.`,
    status.title === undefined ? '' : `当前会话标题：${status.title}.`,
    status.summary === undefined ? '当前没有可用的最近 Agent 摘要。' : `最近 Agent 内容：${status.summary}`,
  ].filter(Boolean).join('\n')
}

function field(value: Record<string, unknown>, name: string): string {
  const result = value[name]
  return typeof result === 'string' ? result : ''
}

function optionalField(value: Record<string, unknown>, name: string): string | undefined {
  const result = value[name]
  return typeof result === 'string' ? result : undefined
}
