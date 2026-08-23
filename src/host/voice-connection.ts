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
import {
  DashScopeRealtime,
  type DashScopeServerEvent,
  type RealtimeFunctionTool,
} from './dashscope-realtime.ts'
import {
  DshVoiceCoordinator,
  type PendingVoiceApproval,
  type PendingVoiceQuestion,
  type VoiceQuestionAnswer,
} from './dsh-coordinator.ts'
import { assistantText, DshVoiceSession } from './dsh-session-state.ts'
import { isWebSocketSendError } from './websocket-send.ts'
import { VoiceRuntime, type VoiceContinuityState } from './voice-runtime.ts'

/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
export class VoiceConnection {
  private readonly provisionalId = randomUUID()
  private continuity: VoiceContinuityState | undefined
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
  /** Mini Program RecorderManager has no iOS native AEC. During downlink audio,
   * only an explicit, locally verified barge-in control re-opens upstream PCM. */
  private suppressMiniInputAudio = false
  private readonly suppressedResponses = new Set<string>()
  private readonly handledFunctionCalls = new Set<string>()
  private latestUserTranscript = ''
  private agentWorkPending = false
  private closed = false
  private ready = false
  private leaseAcquired = false
  private helloTimer: ReturnType<typeof setTimeout>
  private hostEventsAbort: AbortController | undefined
  private readonly pendingAssistantByTurn = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly socket: WebSocket,
    private readonly request: IncomingMessage,
    private readonly config: VoiceConfig,
    private readonly onClosed: () => void,
    private readonly runtime: VoiceRuntime = new VoiceRuntime(),
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

  get id(): string {
    return this.continuity?.id ?? this.provisionalId
  }

  dispose(reason = 'plugin-disposed'): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimer)
    this.hostEventsAbort?.abort()
    this.coordinator = undefined
    this.provider?.close()
    this.provider = undefined
    if (this.leaseAcquired) {
      this.leaseAcquired = false
      this.runtime.release(this.provisionalId)
    }
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(1001, reason)
    }
    this.onClosed()
  }

  private async receive(raw: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return
    if (this.continuity !== undefined) this.runtime.touch(this.continuity)
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
      if (this.suppressMiniInputAudio) return
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
        this.suppressMiniInputAudio = false
        this.interruptActiveResponse('cancelled', true)
        return
      case 'voice.commit':
        this.provider?.commitAudio()
        return
      case 'voice.approval-answer':
        await this.answerApproval(parsed.approvalId, parsed.outcome)
        return
      case 'voice.question-answer':
        await this.answerQuestion(parsed.requestId, parsed.answers)
        return
      case 'voice.ping':
        if (this.continuity !== undefined) this.runtime.touch(this.continuity)
        this.send({ type: 'voice.pong', serverSeq: this.nextSeq(), sentAt: parsed.sentAt })
        return
    }
  }

  private async start(hello: VoiceHello): Promise<void> {
    validateAudioNegotiation(hello)
    clearTimeout(this.helloTimer)
    this.hello = hello
    const lease = this.runtime.acquireLease({
      connectionId: this.provisionalId,
      platform: hello.client.platform,
      clientVersion: hello.client.version,
      sessionId: hello.target.sessionId,
      ...(hello.resume === undefined ? {} : { resumeId: hello.resume.voiceSessionId }),
      revoke: () => this.dispose('voice-resumed-elsewhere'),
    })
    if (!lease.ok) {
      this.send({ type: 'voice.busy', serverSeq: this.nextSeq(), occupancy: lease.occupancy })
      this.dispose('voice-busy')
      return
    }
    this.leaseAcquired = true
    this.continuity = lease.state
    this.session = new DshVoiceSession(this.ctx, hello.target.sessionId)
    const status = await this.session.snapshot()
    const coordinator = new DshVoiceCoordinator(this.ctx, hello.target.sessionId, this.continuity.coordinator)
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
    const instructions = buildInstructions(status, this.continuity)
    const provider = new DashScopeRealtime(this.config, credential.value, instructions, REALTIME_FUNCTION_TOOLS, {
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
      capabilities: { bargeIn: true, functionCalling: true, reconnect: true, persistentAgentTask: true },
    })
    this.sendState('listening')
    if (this.continuity.pendingApproval !== undefined) this.sendApproval(this.continuity.pendingApproval, 'pending')
    if (this.continuity.pendingQuestion !== undefined) this.sendQuestion(this.continuity.pendingQuestion, 'pending')
    this.followDshEvents(hello.target.sessionId)
  }

  private onProviderEvent(event: DashScopeServerEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.suppressMiniInputAudio = false
        // Qwen has already detected this turn and automatically cancels the
        // active response. Only suppress/clear here; a second response.cancel
        // would race and can yield "Conversation has no active response".
        this.interruptActiveResponse('barge-in', false)
        this.sendState('listening')
        return
      case 'input_audio_buffer.speech_stopped':
        this.sendState('thinking')
        return
      case 'conversation.item.input_audio_transcription.delta':
        this.sendTranscript('user', false, field(event, 'text'), optionalField(event, 'stash'))
        return
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = field(event, 'transcript')
        this.latestUserTranscript = transcript.trim()
        if (this.continuity !== undefined) {
          this.continuity.userTranscript = transcript.trim()
          this.runtime.touch(this.continuity)
        }
        this.sendTranscript('user', true, transcript)
        return
      }
      case 'response.created': {
        const response = event.response as Record<string, unknown> | undefined
        this.activeResponseId = typeof response?.id === 'string' ? response.id : undefined
        this.sendState('thinking')
        return
      }
      case 'response.function_call_arguments.done':
        void this.handleFunctionCall(event)
        return
      case 'response.audio.delta': {
        if (this.hello?.client.platform === 'wechat-mini-program') this.suppressMiniInputAudio = true
        const responseId = optionalField(event, 'response_id')
        const effectiveResponseId = responseId ?? this.activeResponseId
        if (effectiveResponseId !== undefined && this.suppressedResponses.has(effectiveResponseId)) return
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
        this.sendTranscript('assistant', false, field(event, 'delta'))
        return
      case 'response.audio_transcript.done':
        if (this.continuity !== undefined) {
          this.continuity.assistantTranscript = field(event, 'transcript').trim()
          this.runtime.touch(this.continuity)
        }
        this.sendTranscript('assistant', true, field(event, 'transcript'))
        return
      case 'response.done': {
        this.suppressMiniInputAudio = false
        const response = event.response as Record<string, unknown> | undefined
        const responseId = typeof response?.id === 'string' ? response.id : undefined
        if (responseId !== undefined) this.suppressedResponses.delete(responseId)
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

  /** Execute only the small semantic bridge vocabulary exposed to Qwen. */
  private async handleFunctionCall(event: DashScopeServerEvent): Promise<void> {
    const callId = field(event, 'call_id')
    const name = field(event, 'name')
    if (callId === '' || name === '' || this.handledFunctionCalls.has(callId) || this.closed) return
    this.handledFunctionCalls.add(callId)
    this.send({ type: 'voice.tool', serverSeq: this.nextSeq(), callId, name, status: 'started' })
    try {
      const args = parseArguments(field(event, 'arguments'))
      let output: unknown
      switch (name) {
        case 'handoff_to_dsh_agent': {
          const instruction = requiredString(args, 'instruction')
          const handoff = await this.coordinator!.handoff(instruction, this.latestUserTranscript)
          this.agentWorkPending = true
          this.sendState('agent-working')
          this.send({
            type: 'voice.agent-status',
            serverSeq: this.nextSeq(),
            sessionId: handoff.sessionId,
            running: true,
            summary: handoff.mode === 'steer' ? '已将补充要求加入正在运行的任务' : 'DSH Agent 已开始执行',
          })
          output = {
            status: 'accepted',
            handoff_id: handoff.handoffId,
            target_session_id: handoff.sessionId,
            mode: handoff.mode,
          }
          break
        }
        case 'cancel_dsh_agent':
          output = await this.coordinator!.cancel(optionalString(args, 'reason') ?? '')
          this.agentWorkPending = false
          break
        case 'answer_dsh_approval': {
          const decision = requiredString(args, 'decision')
          if (decision !== 'allowed-once' && decision !== 'rejected') {
            throw new Error('approval decision must be allowed-once or rejected')
          }
          output = await this.coordinator!.resolveApproval(requiredString(args, 'approval_id'), decision)
          break
        }
        case 'answer_dsh_question':
          output = await this.coordinator!.answerQuestion(
            requiredString(args, 'request_id'),
            parseQuestionAnswers(args.answers),
          )
          break
        default:
          throw new Error(`Unknown realtime bridge tool: ${name}`)
      }
      this.provider?.completeFunctionCall(callId, output)
      this.send({
        type: 'voice.tool',
        serverSeq: this.nextSeq(),
        callId,
        name,
        status: 'completed',
        message: 'DSH 已受理。',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.provider?.completeFunctionCall(callId, { status: 'failed', error: message })
      this.send({ type: 'voice.tool', serverSeq: this.nextSeq(), callId, name, status: 'failed', message })
      this.sendState(this.agentWorkPending ? 'agent-working' : 'listening')
    }
  }

  private followDshEvents(sessionId: string): void {
    const abort = new AbortController()
    this.hostEventsAbort = abort
    const request = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.host(request, abort.signal)) {
        const frame = item.payload
        if (frame.type === 'host/session-status' && frame.sessionId === sessionId) {
          this.agentWorkPending = frame.running || this.coordinator?.active === true
          this.send({ type: 'voice.agent-status', serverSeq: this.nextSeq(), sessionId: frame.sessionId, running: frame.running })
          continue
        }
        if (frame.type === 'host/agent-error' && frame.sessionId === sessionId) {
          this.agentWorkPending = false
          this.send({
            type: 'voice.agent-status',
            serverSeq: this.nextSeq(),
            sessionId,
            running: false,
            summary: 'DSH Agent 运行失败。',
          })
          this.provider?.announceBackendEvent(
            `backend_agent_error_${this.nextSeq()}`,
            '[FAILED] DSH Agent 运行失败。请如实告诉用户任务没有完成，并建议查看绑定任务中的错误详情。',
          )
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.ctx.logger.warn(error)
    })
    const muxRequest = { rpcId: this.rpcId(), payload: {} }
    void (async () => {
      for await (const item of this.ctx.apiProxy.events.mux(muxRequest, abort.signal)) {
        const frame = item.payload
        if (!('sessionId' in frame) || frame.sessionId !== sessionId) continue
        if (frame.type === 'approval/requested') {
          const approval: PendingVoiceApproval = {
            rpcId: item.rpcId,
            approvalId: frame.approvalId,
            sessionId: frame.sessionId,
            toolName: frame.toolName,
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            ...(frame.reason === undefined ? {} : { reason: frame.reason }),
          }
          this.coordinator?.rememberApproval(approval)
          this.agentWorkPending = true
          this.sendApproval(approval, 'pending')
          this.provider?.announceBackendEvent(
            `backend_approval_${frame.approvalId}`,
            `[NEEDS_APPROVAL] DSH 正在等待用户批准。approval_id=${frame.approvalId}；工具=${frame.toolName}；原因=${frame.reason ?? '未提供'}。请简短说明风险并询问用户是否允许一次。用户明确同意或拒绝后，必须调用 answer_dsh_approval；不要把回答当成新任务。`,
          )
          continue
        }
        if (frame.type === 'approval/resolved') {
          const existing = this.coordinator?.listPendingApprovals().find(value => value.approvalId === frame.approvalId)
          this.coordinator?.forgetApproval(frame.approvalId)
          if (existing !== undefined) this.sendApproval(existing, 'resolved', frame.outcome)
          continue
        }
        if (frame.type === 'question/requested') {
          const question: PendingVoiceQuestion = {
            rpcId: item.rpcId,
            sessionId: frame.sessionId,
            questions: frame.questions.map(value => ({
              id: value.id,
              question: value.question,
              ...(value.detail === undefined ? {} : { detail: value.detail }),
              ...(value.header === undefined ? {} : { header: value.header }),
              ...(value.options === undefined ? {} : { options: value.options.map(option => ({ ...option })) }),
              ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
            })),
          }
          this.coordinator?.rememberQuestion(question)
          this.agentWorkPending = true
          this.sendQuestion(question, 'pending')
          this.provider?.announceBackendEvent(
            `backend_question_${item.rpcId}`,
            `[NEEDS_INPUT] DSH Agent 需要用户作决定。request_id=${item.rpcId}。问题：${formatQuestions(question)}。请自然地询问用户；得到明确答案后调用 answer_dsh_question，不要把答案当作新任务。`,
          )
          continue
        }
        if (frame.type === 'question/resolved') {
          const existing = this.coordinator?.listPendingQuestions().find(value => value.rpcId === frame.questionRpcId)
          this.coordinator?.forgetQuestion(frame.questionRpcId)
          if (existing !== undefined) this.sendQuestion(existing, 'resolved', frame.outcome)
          continue
        }
        if (frame.type === 'session/jobs') {
          const active = frame.jobs.filter(job => job.status === 'running' || job.status === 'stopping')
          if (active.length > 0) {
            this.agentWorkPending = true
            this.send({
              type: 'voice.agent-status',
              serverSeq: this.nextSeq(),
              sessionId,
              running: true,
              summary: active.map(job => job.label).join('、').slice(0, 1_200),
            })
          }
          continue
        }
        if (frame.type !== 'session/event') continue
        const event = frame.event
        if (event.type === 'turn/start') {
          const data = event.data as Record<string, unknown>
          if (typeof data.turn === 'number') this.coordinator?.markTurnStarted(data.turn)
          this.agentWorkPending = true
          this.sendState('agent-working')
          continue
        }
        if (event.type === 'assistant/message') {
          const data = event.data as Record<string, unknown>
          const turn = data.turn
          const text = assistantText(event)
          if (typeof turn === 'number' && text !== undefined) {
            this.pendingAssistantByTurn.set(`${frame.sessionId}:${turn}`, text)
            this.send({
              type: 'voice.agent-status',
              serverSeq: this.nextSeq(),
              sessionId,
              running: true,
              summary: text.slice(0, 1_200),
            })
            this.provider?.announceBackendEvent(
              `backend_progress_${event.seq}`,
              `[STATUS] ${text}\n这是执行中的阶段更新。只在它对当前对话有帮助时简短播报，不要把它误当成最终完成。`,
            )
          }
          continue
        }
        if (event.type === 'tool/call') {
          const data = event.data as Record<string, unknown>
          const name = typeof data.name === 'string' ? data.name : '工具'
          this.send({
            type: 'voice.agent-status',
            serverSeq: this.nextSeq(),
            sessionId,
            running: true,
            summary: `正在使用 ${name}`,
          })
          continue
        }
        if (event.type !== 'turn/end') continue
        const data = event.data as Record<string, unknown>
        const turn = data.turn
        if (typeof turn !== 'number') continue
        const key = `${frame.sessionId}:${turn}`
        const text = this.pendingAssistantByTurn.get(key)
        this.pendingAssistantByTurn.delete(key)
        const reason = turnEndKind(data.reason)
        this.coordinator?.markTurnEnded(turn, reason)
        this.agentWorkPending = false
        this.send({
          type: 'voice.agent-status',
          serverSeq: this.nextSeq(),
          sessionId,
          running: false,
          ...(text === undefined ? {} : { summary: text.slice(0, 1_200) }),
        })
        const resultText = text ?? `DSH Agent 已结束本轮工作，结束状态为 ${reason}。`
        const completionTag = reason === 'completed' ? '[COMPLETE]' : reason === 'cancelled' ? '[CANCELLED]' : '[FAILED]'
        this.provider?.announceBackendEvent(
          `backend_complete_${event.seq}`,
          `${completionTag} ${resultText}\n这是绑定 DSH 任务的权威终态。请简短、准确地向用户汇报；不要再次提交已经完成的任务。`,
        )
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.ctx.logger.warn(error)
    })
  }

  private async answerApproval(
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<void> {
    const pending = this.coordinator?.listPendingApprovals().find(value => value.approvalId === approvalId)
    if (pending === undefined) throw new Error(`DSH approval is no longer pending: ${approvalId}`)
    await this.coordinator!.resolveApproval(approvalId, outcome)
    this.coordinator!.forgetApproval(approvalId)
    this.sendApproval(pending, 'resolved', outcome)
    this.provider?.announceBackendEvent(
      `backend_approval_answer_${approvalId}_${outcome}`,
      `[STATUS] 用户已${outcome === 'allowed-once' ? '允许本次操作' : '拒绝本次操作'}，DSH Agent 将继续处理。无需再次询问。`,
    )
  }

  private async answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): Promise<void> {
    const pending = this.coordinator?.listPendingQuestions().find(value => value.rpcId === requestId)
    if (pending === undefined) throw new Error(`DSH question is no longer pending: ${requestId}`)
    await this.coordinator!.answerQuestion(requestId, answers)
    this.coordinator!.forgetQuestion(requestId)
    this.sendQuestion(pending, 'resolved', 'answered')
    this.provider?.announceBackendEvent(
      `backend_question_answer_${requestId}`,
      '[STATUS] 用户的补充答案已经送回 DSH Agent，任务将继续。无需重复提问。',
    )
  }

  private sendApproval(
    approval: PendingVoiceApproval,
    status: 'pending' | 'resolved',
    outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
  ): void {
    if (this.continuity !== undefined) {
      if (status === 'pending') this.continuity.pendingApproval = approval
      else delete this.continuity.pendingApproval
      this.runtime.touch(this.continuity)
    }
    this.send({
      type: 'voice.approval',
      serverSeq: this.nextSeq(),
      sessionId: approval.sessionId,
      status,
      approval: {
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        ...(approval.callId === undefined ? {} : { callId: approval.callId }),
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      },
      ...(outcome === undefined ? {} : { outcome }),
    })
  }

  private sendQuestion(
    question: PendingVoiceQuestion,
    status: 'pending' | 'resolved',
    outcome?: 'answered' | 'cancelled',
  ): void {
    if (this.continuity !== undefined) {
      if (status === 'pending') this.continuity.pendingQuestion = question
      else delete this.continuity.pendingQuestion
      this.runtime.touch(this.continuity)
    }
    this.send({
      type: 'voice.question',
      serverSeq: this.nextSeq(),
      sessionId: question.sessionId,
      status,
      question: {
        requestId: question.rpcId,
        questions: question.questions.map(value => ({
          ...value,
          ...(value.options === undefined ? {} : { options: value.options.map(option => ({ ...option })) }),
        })),
      },
      ...(outcome === undefined ? {} : { outcome }),
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

export function buildInstructions(
  status: { running: boolean; blank: boolean; cwd?: string; title?: string; summary?: string },
  continuity?: Pick<VoiceContinuityState, 'userTranscript' | 'assistantTranscript'>,
): string {
  return [
    '你是 DeepSeek Harness 中一个统一助手的实时语音界面。你的首要目标是像自然通话一样快速、简洁地回应，并保持可随时打断。',
    '你负责低延迟交谈；绑定的 DSH Agent 负责真正执行任务。两者是同一个助手的对话面和执行面，不要向用户讲“后端”“工具路由”或内部实现。',
    '普通寒暄、解释、简单问答以及只依赖当前对话即可回答的内容，由你立即回答，不调用工具。',
    '凡是用户要求读取或修改文件、操作应用或设备、运行命令、写代码、查询绑定任务、使用项目上下文、联网研究、打印、发送，或任何需要真实执行和验证的工作，必须调用 handoff_to_dsh_agent。不要只教用户手动操作，也不要声称自己无法访问；让 DSH Agent 先实际尝试。',
    'handoff_to_dsh_agent 返回 accepted 只代表已受理，绝不代表完成。你可以立即自然确认“我来处理”，保持对话可继续；只有 [BACKEND][COMPLETE] 才能说任务已经完成。',
    'DSH 工作期间，用户的新约束、纠正或补充仍调用 handoff_to_dsh_agent；宿主会自动把它 steer 进同一正在执行的任务。用户要求停止时调用 cancel_dsh_agent。',
    '收到 [BACKEND][STATUS] 时，只在有帮助时用一句话播报进展；它不是终态。收到 [BACKEND][COMPLETE]、[FAILED] 或 [CANCELLED] 时，如实、简短播报权威结果，且不要重新提交已经结束的工作。',
    '收到 [BACKEND][NEEDS_APPROVAL] 时，简短说明要做的操作和风险并询问用户；得到明确同意或拒绝后调用 answer_dsh_approval。收到 [BACKEND][NEEDS_INPUT] 时自然提问，得到答案后调用 answer_dsh_question。此类回答不是新任务。',
    '如果一句话既包含可立即回答的问题又包含要执行的任务，可以先简短回答，再调用 handoff_to_dsh_agent；不要为了调用工具而长时间沉默。',
    `当前 DSH 状态：running=${String(status.running)}, blank=${String(status.blank)}.`,
    status.cwd === undefined ? '' : `当前项目目录：${status.cwd}.`,
    status.title === undefined ? '' : `当前会话标题：${status.title}.`,
    status.summary === undefined ? '当前没有可用的最近 Agent 摘要。' : `最近 Agent 内容：${status.summary}`,
    continuity?.userTranscript === '' || continuity?.userTranscript === undefined ? '' : `断线前用户最后一句：${continuity.userTranscript}`,
    continuity?.assistantTranscript === '' || continuity?.assistantTranscript === undefined ? '' : `断线前你最后一句：${continuity.assistantTranscript}`,
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

const REALTIME_FUNCTION_TOOLS: readonly RealtimeFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'handoff_to_dsh_agent',
      description: '把需要真实执行、访问 DSH 会话/项目/文件/应用/设备/网络或持续 Agent 工作的用户意图交给绑定的 DSH Agent。若 Agent 正在运行，调用会成为同一任务的实时纠正或补充。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction'],
        properties: {
          instruction: {
            type: 'string',
            description: '完整、可执行的用户要求，保留对象、约束、格式和验收条件；不要添加用户没有说过的事实。',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_dsh_agent',
      description: '当用户明确要求停止或取消当前绑定的 DSH Agent 工作时调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string', description: '用户要求取消的原因，可省略。' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_dsh_approval',
      description: '回答 DSH Agent 正在等待的操作审批。仅在用户已经明确同意或拒绝后调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['approval_id', 'decision'],
        properties: {
          approval_id: { type: 'string' },
          decision: { type: 'string', enum: ['allowed-once', 'rejected'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_dsh_question',
      description: '把用户对 DSH Agent 结构化追问的答案送回原请求。仅用于当前 [NEEDS_INPUT]。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['request_id', 'answers'],
        properties: {
          request_id: { type: 'string' },
          answers: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
]

function parseArguments(value: string): Record<string, unknown> {
  if (value.trim() === '') return {}
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Realtime function arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const result = optionalString(value, name)
  if (result === undefined || result === '') throw new Error(`Missing realtime function argument: ${name}`)
  return result
}

function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  const result = value[name]
  return typeof result === 'string' ? result.trim() : undefined
}

function parseQuestionAnswers(value: unknown): VoiceQuestionAnswer[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Question answers must be a non-empty array')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Invalid question answer')
    const answer = item as Record<string, unknown>
    const id = requiredString(answer, 'id')
    if (!Array.isArray(answer.selected) || !answer.selected.every(option => typeof option === 'string')) {
      throw new Error(`Question answer ${id} has invalid selected options`)
    }
    const custom = optionalString(answer, 'custom')
    return { id, selected: answer.selected.map(option => option.trim()), ...(custom === undefined ? {} : { custom }) }
  })
}

function formatQuestions(value: PendingVoiceQuestion): string {
  return value.questions.map((question) => {
    const options = question.options?.map(option => option.label).join('、')
    return `${question.id}: ${question.question}${options === undefined || options === '' ? '' : `（选项：${options}）`}`
  }).join('；')
}

function turnEndKind(value: unknown): 'completed' | 'cancelled' | 'failed' {
  const kind = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).kind === 'string'
      ? (value as Record<string, unknown>).kind as string
      : 'completed'
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled') return 'cancelled'
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens' || kind === 'failed') return 'failed'
  return 'completed'
}
