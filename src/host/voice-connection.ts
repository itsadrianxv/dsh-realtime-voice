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
import { assistantText, DshVoiceTools, type VoiceToolCall } from './dsh-tools.ts'

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
  private tools: DshVoiceTools | undefined
  private activeResponseId: string | undefined
  private readonly suppressedResponses = new Set<string>()
  private closed = false
  private ready = false
  private helloTimer: ReturnType<typeof setTimeout>
  private hostEventsAbort: AbortController | undefined
  private readonly pendingAssistantByTurn = new Map<number, string>()

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
        this.provider?.cancelResponse()
        this.clearPlayback('cancelled')
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
    this.tools = new DshVoiceTools(this.ctx, hello.target.sessionId)
    const status = await this.tools.status()
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv))
    if (credential === undefined) {
      this.fail('credential-missing', `DSH 凭据 ${this.config.apiKeyEnv} 尚未配置。`, false)
      return
    }
    const instructions = buildInstructions(status)
    const provider = new DashScopeRealtime(this.config, credential.value, instructions, {
      onEvent: event => this.onProviderEvent(event),
      onTool: call => this.runTool(call),
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
      provider: { id: 'dashscope', model: this.config.model, voice: this.config.voice },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: INPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        output: { encoding: 'pcm_s16le', sampleRate: OUTPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        maxBinaryFrameBytes: this.config.maxBinaryFrameBytes,
      },
      capabilities: { bargeIn: true, functionCalling: true, reconnect: true, persistentAgentTask: true },
    })
    this.sendState('listening')
    this.followDshEvents(hello.target.sessionId)
  }

  private onProviderEvent(event: DashScopeServerEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        if (this.activeResponseId !== undefined) this.suppressedResponses.add(this.activeResponseId)
        this.clearPlayback('barge-in')
        this.sendState('listening')
        return
      case 'input_audio_buffer.speech_stopped':
        this.sendState('thinking')
        return
      case 'conversation.item.input_audio_transcription.delta':
        this.sendTranscript('user', false, field(event, 'text'), optionalField(event, 'stash'))
        return
      case 'conversation.item.input_audio_transcription.completed':
        this.sendTranscript('user', true, field(event, 'transcript'))
        return
      case 'response.created': {
        const response = event.response as Record<string, unknown> | undefined
        this.activeResponseId = typeof response?.id === 'string' ? response.id : undefined
        this.sendState('thinking')
        return
      }
      case 'response.audio.delta': {
        const responseId = optionalField(event, 'response_id')
        if (responseId !== undefined && this.suppressedResponses.has(responseId)) return
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
        this.socket.send(frame, { binary: true })
        this.sendState('speaking')
        return
      }
      case 'response.audio_transcript.delta':
        this.sendTranscript('assistant', false, field(event, 'delta'))
        return
      case 'response.audio_transcript.done':
        this.sendTranscript('assistant', true, field(event, 'transcript'))
        return
      case 'response.done': {
        const response = event.response as Record<string, unknown> | undefined
        const responseId = typeof response?.id === 'string' ? response.id : undefined
        if (responseId !== undefined) this.suppressedResponses.delete(responseId)
        this.activeResponseId = undefined
        this.sendState('listening')
        return
      }
      case 'transport.closed':
        this.fail('provider-disconnected', '百炼实时语音连接已断开。', true)
        this.dispose('provider-disconnected')
        return
      case 'error': {
        const error = event.error as Record<string, unknown> | undefined
        const message = typeof error?.message === 'string' ? error.message : '百炼实时语音服务返回错误。'
        this.fail('provider-error', message, true)
        return
      }
    }
  }

  private async runTool(call: VoiceToolCall) {
    this.send({ type: 'voice.tool', serverSeq: this.nextSeq(), callId: call.callId, name: call.name, status: 'started' })
    this.sendState('agent-working')
    const result = await this.tools!.execute(call)
    this.send({
      type: 'voice.tool',
      serverSeq: this.nextSeq(),
      callId: call.callId,
      name: call.name,
      status: result.ok ? 'completed' : 'failed',
      message: result.ok ? 'DSH 已接受操作。' : result.output,
    })
    return result
  }

  private followDshEvents(sessionId: string): void {
    const abort = new AbortController()
    this.hostEventsAbort = abort
    const request = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.host(request, abort.signal)) {
        const frame = item.payload
        if (frame.type === 'host/session-status' && frame.sessionId === sessionId) {
          this.send({ type: 'voice.agent-status', serverSeq: this.nextSeq(), sessionId, running: frame.running })
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.ctx.logger.warn(error)
    })
    const muxRequest = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.mux(muxRequest, abort.signal)) {
        const frame = item.payload
        if (frame.type !== 'session/event' || frame.sessionId !== sessionId) continue
        const event = frame.event
        if (event.type === 'assistant/message') {
          const data = event.data as Record<string, unknown>
          const turn = data.turn
          const text = assistantText(event)
          if (typeof turn === 'number' && text !== undefined) this.pendingAssistantByTurn.set(turn, text)
          continue
        }
        if (event.type !== 'turn/end') continue
        const data = event.data as Record<string, unknown>
        const turn = data.turn
        if (typeof turn !== 'number') continue
        const text = this.pendingAssistantByTurn.get(turn)
        this.pendingAssistantByTurn.delete(turn)
        if (text === undefined) continue
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

function buildInstructions(status: { running: boolean; blank: boolean; cwd?: string; title?: string; summary?: string }): string {
  return [
    '你是 DeepSeek Harness 的实时语音控制助理。使用自然、简短的中文对话。',
    '你只负责听懂用户、调用允许的 DSH 工具、查询进度和播报结果；不要自己假装修改代码。',
    '用户要求编写、修改、检查、运行或继续任何实际工作时，必须调用 start_task 或 send_task_message；绝不能只口头答应，也不要声称自己不能操作 Agent。收到工具成功结果后才能说已提交。',
    '运行中的紧急纠偏使用 send_task_message 的 steer；非紧急后续工作使用 queue。',
    '用户询问其他工作区、线程或会话时，先调用 list_sessions 检索；选中结果后再调用 get_session_latest_reply。不要把“当前没有运行任务”误当成“目标会话不存在”。',
    'start_task、send_task_message、get_task_status 和 cancel_task 始终作用于本次通话绑定的当前会话；跨会话工具目前只读。',
    '收到标记为“DSH Agent 刚完成”的系统上下文时，这是长期 DSH 会话的权威结果；简短播报并允许用户继续追问，不要把它当成新的工作指令。',
    '取消任务前，只有在用户意思明确时才调用 cancel_task。',
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
