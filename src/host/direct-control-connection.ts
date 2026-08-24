import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type WebSocket from 'ws'
import {
  VOICE_DIRECT_PROTOCOL,
  isDirectVoiceClientControl,
  type DirectBackendEventKind,
  type DirectClientMetrics,
  type DirectMediaOffer,
  type DirectVoiceHello,
  type DirectVoiceServerControl,
} from '../direct-protocol.ts'
import type { VoiceQuestionAnswer } from './dsh-coordinator.ts'
import { DshVoiceCoordinator, type PendingVoiceApproval, type PendingVoiceQuestion } from './dsh-coordinator.ts'
import { DshVoiceSession } from './dsh-session-state.ts'
import { DshFunctionBridge } from './dsh-function-bridge.ts'
import { DshBackendBridge, type DshBackendEvent } from './dsh-backend-bridge.ts'
import { buildDirectMediaOfferBootstrap, buildVoiceInstructions } from './voice-bootstrap.ts'
import type { VoiceConfig } from './config.ts'
import { TemporaryKeyService } from './temporary-key-service.ts'
import {
  VoiceRuntime,
  type DirectBackendEventRecord,
  type DirectVoiceContinuityState,
  type VoiceContinuityState,
} from './voice-runtime.ts'

const MAX_CONTROL_FRAME_BYTES = 64 * 1024
const REFRESH_SKEW_SECONDS = 10
const MIN_REFRESH_INTERVAL_MS = 5_000
const CONTROL_HEARTBEAT_TIMEOUT_MS = 45_000

/** Direct-media control plane. Binary/PCM frames are categorically forbidden. */
export class DirectControlConnection {
  private readonly provisionalId = randomUUID()
  private continuity: VoiceContinuityState | undefined
  private direct: DirectVoiceContinuityState | undefined
  private hello: DirectVoiceHello | undefined
  private coordinator: DshVoiceCoordinator | undefined
  private functionBridge: DshFunctionBridge | undefined
  private serverSeq = 0
  private closed = false
  private ready = false
  private leaseAcquired = false
  private lastClientActivityAt = Date.now()
  private functionQueue: Promise<void> = Promise.resolve()
  private readonly helloTimer: ReturnType<typeof setTimeout>
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly socket: WebSocket,
    private readonly request: IncomingMessage,
    private readonly config: VoiceConfig,
    private readonly onClosed: () => void,
    private readonly runtime: VoiceRuntime,
    private readonly temporaryKeys = new TemporaryKeyService(),
  ) {
    void this.request
    this.helloTimer = setTimeout(() => this.fail('hello-timeout', '客户端未及时发送 direct voice.hello。', false), 10_000)
    socket.on('message', (data, isBinary) => {
      void this.receive(data, isBinary).catch((error: unknown) => {
        this.fail(
          this.ready ? 'bad-client-message' : 'direct-start-failed',
          safeError(error),
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
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    // A provider socket cannot remain authoritative without its owning control
    // transport. DashScope tokens are handshake-only and cannot be revoked, so
    // sever the Host association immediately; a valid resume receives a fresh offer.
    if (this.direct !== undefined) delete this.direct.activeMedia
    // Keep durable event projection alive during resume grace without letting a
    // detached connection advance the shared control sequence. Pending cards
    // stay in the coordinator and are snapshotted by the resumed transport.
    this.direct?.backendBridge?.setCallbacks({
      onAgentStatus() {},
      onApproval() {},
      onQuestion() {},
      onBackendEvent: event => this.recordBackendEvent(event),
    })
    if (this.leaseAcquired) {
      this.leaseAcquired = false
      this.runtime.release(this.provisionalId, this.ready && isTransientDisconnect(reason))
    }
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(1001, reason)
    }
    this.onClosed()
  }

  private async receive(raw: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return
    if (isBinary) {
      this.fail('raw-audio-forbidden', 'dsh.voice.direct.v1 控制通道禁止任何二进制或 PCM 数据。', false)
      return
    }
    const bytes = rawDataLength(raw)
    if (bytes > MAX_CONTROL_FRAME_BYTES) throw new Error('direct control frame exceeds 64 KiB')
    const parsed: unknown = JSON.parse(raw.toString())
    if (!isDirectVoiceClientControl(parsed)) throw new Error('unknown direct voice control message')
    this.lastClientActivityAt = Date.now()
    if (parsed.type !== 'voice.hello' && this.continuity === undefined) throw new Error('control arrived before voice.ready')
    if (this.continuity !== undefined) this.runtime.touch(this.continuity)

    switch (parsed.type) {
      case 'voice.hello':
        if (this.hello !== undefined) throw new Error('voice.hello may only be sent once')
        await this.start(parsed)
        return
      case 'voice.end':
        this.send({ type: 'voice.ended', serverSeq: this.nextSeq(), reason: parsed.reason ?? 'client-ended' })
        this.dispose('client-ended')
        return
      case 'voice.ping':
        this.send({ type: 'voice.pong', serverSeq: this.nextSeq(), sentAt: parsed.sentAt })
        return
      case 'media.refresh':
        await this.refreshOffer(parsed.previousOfferId, parsed.reason)
        return
      case 'media.connected':
        this.mediaConnected(parsed.offerId, parsed.mediaSessionId, parsed.connectedAt)
        return
      case 'media.closed':
        this.mediaClosed(parsed.offerId, parsed.mediaSessionId)
        return
      case 'provider.function-call':
        await this.enqueueFunctionCall(() => this.executeFunctionCall(
          parsed.offerId,
          parsed.mediaSessionId,
          parsed.callId,
          parsed.name,
          parsed.arguments,
        ))
        return
      case 'voice.backend-ack':
        this.ackBackendEvent(parsed.eventId, parsed.eventSeq)
        return
      case 'voice.approval-answer':
        await this.answerApproval(parsed.approvalId, parsed.outcome)
        return
      case 'voice.question-answer':
        await this.answerQuestion(parsed.requestId, parsed.answers)
        return
      case 'client.metrics':
        this.acceptMetrics(parsed.offerId, parsed.mediaSessionId, parsed.values)
        return
    }
  }

  private async start(hello: DirectVoiceHello): Promise<void> {
    clearTimeout(this.helloTimer)
    this.hello = hello
    if (!hello.client.websocketAuthorizationHeader) {
      this.fail(
        'media-transport-unsupported',
        '百炼 Realtime WSS 要求 Authorization 握手头；当前客户端运行时不支持。标准浏览器 WebSocket 必须继续使用隔离的 dsh.voice.v1。',
        false,
      )
      return
    }
    const lease = this.runtime.acquireLease({
      connectionId: this.provisionalId,
      protocol: VOICE_DIRECT_PROTOCOL,
      platform: hello.client.platform,
      clientVersion: hello.client.version,
      sessionId: hello.target.sessionId,
      ...(hello.resume === undefined ? {} : { resumeId: hello.resume.voiceSessionId }),
      revoke: () => this.dispose('voice-resumed-elsewhere'),
    })
    if (!lease.ok) {
      if (lease.reason === 'busy') {
        this.send({ type: 'voice.busy', serverSeq: this.nextSeq(), occupancy: lease.occupancy })
        this.dispose('voice-busy')
      } else {
        this.fail('resume-rejected', '语音恢复凭证已过期、无效或与客户端、协议、DSH 会话不匹配。', false)
      }
      return
    }
    this.leaseAcquired = true
    this.continuity = lease.state
    if (hello.resume !== undefined && hello.resume.lastServerSeq > lease.state.serverSeq) {
      this.fail('resume-sequence-invalid', '客户端恢复序号超出 Host 权威水位。', false)
      return
    }
    this.serverSeq = lease.state.serverSeq
    this.direct = lease.state.direct ??= createDirectState()
    if (hello.resume !== undefined && hello.resume.lastBackendEventSeq > this.direct.nextBackendEventSeq) {
      this.fail('resume-backend-sequence-invalid', '客户端后端事件恢复序号超出 Host 权威水位。', false)
      return
    }

    const session = new DshVoiceSession(this.ctx, hello.target.sessionId)
    const status = await session.snapshot()
    const coordinator = new DshVoiceCoordinator(this.ctx, hello.target.sessionId, lease.state.coordinator)
    this.coordinator = coordinator
    this.functionBridge = new DshFunctionBridge(coordinator, lease.state.functionReceipts, {
      onApprovalResolved: (approval, outcome) => this.afterApprovalResolved(approval, outcome),
      onQuestionResolved: question => this.afterQuestionResolved(question),
    }, lease.state.interactionReceipts)
    const offer = await this.issueOffer(buildVoiceInstructions(status, lease.state))
    if (this.closed) return

    const backendCallbacks = this.backendCallbacks()
    if (this.direct.backendBridge === undefined) {
      this.direct.backendBridge = new DshBackendBridge(this.ctx, hello.target.sessionId, coordinator, backendCallbacks)
    } else {
      this.direct.backendBridge.setCallbacks(backendCallbacks)
    }
    this.ready = true
    this.heartbeatTimer = setInterval(() => this.checkControlHeartbeat(), 5_000)
    this.heartbeatTimer.unref?.()
    this.send({
      type: 'voice.ready',
      protocol: VOICE_DIRECT_PROTOCOL,
      voiceSessionId: this.id,
      serverSeq: this.nextSeq(),
      target: { sessionId: hello.target.sessionId, running: status.running || coordinator.active },
      capabilities: {
        directMedia: true,
        reconnect: true,
        functionBridge: true,
        backendEventAck: true,
        rawAudioOnControl: false,
      },
      mediaOffer: offer,
    })
    this.direct.backendBridge.snapshotPendingInteractions()
    this.replayBackendEvents()
    await this.direct.backendBridge.start()
    this.direct.backendBridge.emitCurrentStatus()
  }

  private async issueOffer(instructions?: string): Promise<DirectMediaOffer> {
    const direct = this.direct
    if (direct === undefined) throw new Error('temporary credential issuer is not ready')
    if (direct.pendingOffer !== undefined) return direct.pendingOffer
    direct.lastOfferIssuedAt = Date.now()
    const pending = (async (): Promise<DirectMediaOffer> => {
      // Resolve just in time so credential replacement takes effect on the next
      // offer and the permanent secret is not retained for the call lifetime.
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv))
      if (credential === undefined) throw new Error(`未检测到 ${this.config.apiKeyEnv}，无法签发百炼临时凭证。`)
      const key = await this.temporaryKeys.issue(
        this.config.temporaryKeyEndpoint,
        credential.value,
        this.config.temporaryKeyTtlSeconds,
        this.config.connectTimeoutMs,
      )
      const endpoint = new URL(this.config.endpoint)
      if (endpoint.protocol !== 'wss:') throw new Error('direct media endpoint must use WSS')
      endpoint.searchParams.set('model', this.config.model)
      const effectiveInstructions = instructions ?? buildVoiceInstructions(
        await new DshVoiceSession(this.ctx, this.hello!.target.sessionId).snapshot(),
        this.continuity,
      )
      const offer: DirectMediaOffer = {
        offerId: randomUUID(),
        transport: 'websocket',
        endpoint: endpoint.toString(),
        authorization: {
          scheme: 'Bearer',
          temporaryBearer: key.token,
          expiresAt: key.expiresAt,
          authenticationPhase: 'handshake-only',
        },
        model: this.config.model,
        voice: this.config.voice,
        audio: {
          input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, recommendedChunkDurationMs: 32 },
          output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, providerDeltaFraming: 'variable' },
        },
        bootstrap: buildDirectMediaOfferBootstrap(this.config, effectiveInstructions),
      }
      direct.currentOffer = offer
      return offer
    })()
    direct.pendingOffer = pending
    try {
      return await pending
    } finally {
      if (direct.pendingOffer === pending) delete direct.pendingOffer
    }
  }

  private async refreshOffer(previousOfferId: string, reason: 'expiring' | 'reconnect'): Promise<void> {
    const direct = this.direct!
    const current = direct.currentOffer
    if (current === undefined || current.offerId !== previousOfferId) throw new Error('media refresh references a stale offer')
    if (direct.activeMedia !== undefined) {
      throw new Error('close the active media session before requesting a replacement offer')
    }
    if (Date.now() - (direct.lastOfferIssuedAt ?? 0) < MIN_REFRESH_INTERVAL_MS) throw new Error('media refresh is rate limited')
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (reason === 'expiring' && current.authorization.expiresAt - nowSeconds > REFRESH_SKEW_SECONDS) {
      throw new Error('healthy media does not need an early credential refresh')
    }
    try {
      const offer = await this.issueOffer()
      if (!this.closed) this.send({ type: 'media.offer', serverSeq: this.nextSeq(), mediaOffer: offer })
    } catch (error) {
      this.fail('temporary-key-refresh-failed', safeError(error), true)
    }
  }

  private mediaConnected(offerId: string, mediaSessionId: string, connectedAt: number): void {
    const direct = this.direct!
    const offer = direct.currentOffer
    if (offer === undefined || offer.offerId !== offerId) throw new Error('media.connected references a stale offer')
    if (offer.authorization.expiresAt < Math.floor(connectedAt / 1000) - 5) {
      throw new Error('media.connected used an expired temporary credential')
    }
    if (Math.abs(Date.now() - connectedAt) > 60_000) throw new Error('media.connected timestamp is outside the accepted clock window')
    const active = direct.activeMedia
    if (active !== undefined && (active.offerId !== offerId || active.mediaSessionId !== mediaSessionId)) {
      throw new Error('one voice lease cannot bind multiple media sessions')
    }
    direct.activeMedia = { offerId, mediaSessionId, connectedAt: Date.now() }
    // Authentication has completed; retain only non-secret offer metadata in
    // the continuity ledger. The client already owns its provider socket.
    offer.authorization.temporaryBearer = ''
    this.send({ type: 'media.state', serverSeq: this.nextSeq(), offerId, mediaSessionId, state: 'connected' })
  }

  private mediaClosed(offerId: string, mediaSessionId: string): void {
    const active = this.direct!.activeMedia
    if (active === undefined || active.offerId !== offerId || active.mediaSessionId !== mediaSessionId) {
      throw new Error('media.closed does not match the active media session')
    }
    delete this.direct!.activeMedia
    const prefix = `${offerId}\0${mediaSessionId}\0`
    for (const key of this.direct!.deliveredFunctionResults) {
      if (key.startsWith(prefix)) this.direct!.deliveredFunctionResults.delete(key)
    }
    this.send({ type: 'media.state', serverSeq: this.nextSeq(), offerId, mediaSessionId, state: 'closed' })
  }

  private async executeFunctionCall(
    offerId: string,
    mediaSessionId: string,
    callId: string,
    name: string,
    argumentsJson: string,
  ): Promise<void> {
    this.assertActiveMedia(offerId, mediaSessionId)
    const scope = `${offerId}\0${mediaSessionId}`
    const resultKey = `${scope}\0${callId}`
    const result = await this.functionBridge!.execute(callId, name, argumentsJson, '', scope)
    if (result.conflict === true) {
      delete this.direct!.activeMedia
      this.fail('function-call-conflict', '同一媒体会话重复使用 callId 且内容冲突；媒体关联已撤销。', true)
      return
    }
    const active = this.direct!.activeMedia
    if (this.closed || active?.offerId !== offerId || active.mediaSessionId !== mediaSessionId) {
      this.recordBackendEvent({
        eventId: `direct:${this.id}:function:${callId}:orphaned`,
        kind: result.ok ? 'status' : 'failed',
        text: result.ok
          ? '[BACKEND][STATUS] 一个语音工具调用已由 DSH 受理，但原媒体会话已更换；请从 DSH Agent 状态继续跟踪。'
          : '[BACKEND][FAILED] 一个语音工具调用失败，且原媒体会话已更换。',
      })
      return
    }
    if (this.direct!.deliveredFunctionResults.has(resultKey)) return
    this.direct!.deliveredFunctionResults.add(resultKey)
    this.send({
      type: 'provider.function-result',
      serverSeq: this.nextSeq(),
      offerId,
      mediaSessionId,
      callId,
      output: result.output,
      cached: result.cached,
    })
  }

  private enqueueFunctionCall(action: () => Promise<void>): Promise<void> {
    const next = this.functionQueue.then(action)
    this.functionQueue = next.catch(() => {})
    return next
  }

  private async answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    await this.functionBridge!.answerApproval(approvalId, outcome)
  }

  private async answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): Promise<void> {
    await this.functionBridge!.answerQuestion(requestId, answers)
  }

  private afterApprovalResolved(approval: PendingVoiceApproval, outcome: 'allowed-once' | 'rejected'): void {
    this.retireBackendEvent(`dsh:${approval.sessionId}:approval:${approval.approvalId}:requested`)
    this.sendApproval(approval, 'resolved', outcome)
    const next = this.coordinator?.listPendingApprovals()[0]
    if (next !== undefined) this.sendApproval(next, 'pending')
    this.recordBackendEvent({
      eventId: `dsh:${approval.sessionId}:approval:${approval.approvalId}:answered:${outcome}`,
      kind: 'status',
      text: `[BACKEND][STATUS] 用户已${outcome === 'allowed-once' ? '允许本次操作' : '拒绝本次操作'}，DSH Agent 将继续处理。`,
    })
  }

  private afterQuestionResolved(question: PendingVoiceQuestion): void {
    this.retireBackendEvent(`dsh:${question.sessionId}:question:${question.rpcId}:requested`)
    this.sendQuestion(question, 'resolved', 'answered')
    const next = this.coordinator?.listPendingQuestions()[0]
    if (next !== undefined) this.sendQuestion(next, 'pending')
    this.recordBackendEvent({
      eventId: `dsh:${question.sessionId}:question:${question.rpcId}:answered`,
      kind: 'status',
      text: '[BACKEND][STATUS] 用户答案已经送回 DSH Agent，任务将继续。',
    })
  }

  private backendCallbacks() {
    return {
      onAgentStatus: (status: { sessionId: string; running: boolean; summary?: string }) => {
        this.send({ type: 'voice.agent-status', serverSeq: this.nextSeq(), ...status })
      },
      onApproval: (
        approval: PendingVoiceApproval,
        status: 'pending' | 'resolved',
        outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
      ) => {
        if (status === 'resolved') this.retireBackendEvent(`dsh:${approval.sessionId}:approval:${approval.approvalId}:requested`)
        this.sendApproval(approval, status, outcome)
      },
      onQuestion: (
        question: PendingVoiceQuestion,
        status: 'pending' | 'resolved',
        outcome?: 'answered' | 'cancelled',
      ) => {
        if (status === 'resolved') this.retireBackendEvent(`dsh:${question.sessionId}:question:${question.rpcId}:requested`)
        this.sendQuestion(question, status, outcome)
      },
      onBackendEvent: (event: DshBackendEvent) => this.recordBackendEvent(event),
    }
  }

  private recordBackendEvent(event: { eventId: string; kind: DirectBackendEventKind; text: string }): void {
    const direct = this.direct
    if (direct === undefined) return
    const existing = direct.backendEvents.get(event.eventId)
    if (existing !== undefined) {
      if (existing.kind !== event.kind || existing.text !== event.text) {
        this.ctx.logger.warn(`[realtime-voice] conflicting direct backend event id: ${event.eventId}`)
      }
      return
    }
    const record: DirectBackendEventRecord = {
      eventId: event.eventId,
      eventSeq: ++direct.nextBackendEventSeq,
      kind: event.kind,
      text: event.text.slice(0, 4_000),
      acknowledged: false,
    }
    pruneBackendEvents(direct.backendEvents, 255)
    if (direct.backendEvents.size >= 256) {
      this.fail('backend-event-overflow', '后端事件确认积压已达上限；请恢复控制连接并从 DSH 会话读取权威状态。', true)
      return
    }
    direct.backendEvents.set(record.eventId, record)
    if (!this.closed) this.sendBackendEvent(record)
  }

  private replayBackendEvents(): void {
    for (const event of [...this.direct!.backendEvents.values()].sort((a, b) => a.eventSeq - b.eventSeq)) {
      if (!event.acknowledged) this.sendBackendEvent(event)
    }
  }

  private retireBackendEvent(eventId: string): void {
    this.direct?.backendEvents.delete(eventId)
  }

  private sendBackendEvent(event: DirectBackendEventRecord): void {
    this.send({
      type: 'voice.backend-event',
      serverSeq: this.nextSeq(),
      eventId: event.eventId,
      eventSeq: event.eventSeq,
      kind: event.kind,
      text: event.text,
    })
  }

  private ackBackendEvent(eventId: string, eventSeq: number): void {
    const event = this.direct!.backendEvents.get(eventId)
    if (event === undefined || event.eventSeq !== eventSeq) throw new Error('backend ACK does not match an issued event')
    event.acknowledged = true
  }

  private sendApproval(
    approval: PendingVoiceApproval,
    status: 'pending' | 'resolved',
    outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
  ): void {
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

  private acceptMetrics(
    offerId: string | undefined,
    mediaSessionId: string | undefined,
    values: DirectClientMetrics,
  ): void {
    if (offerId !== undefined || mediaSessionId !== undefined) {
      if (offerId === undefined || mediaSessionId === undefined) throw new Error('media metrics require both offerId and mediaSessionId')
      this.assertActiveMedia(offerId, mediaSessionId)
    }
    this.direct!.metrics = values
  }

  private assertActiveMedia(offerId: string, mediaSessionId: string): void {
    const active = this.direct!.activeMedia
    if (active === undefined || active.offerId !== offerId || active.mediaSessionId !== mediaSessionId) {
      throw new Error('provider control does not belong to the active media session')
    }
  }

  private checkControlHeartbeat(): void {
    if (this.closed || !this.ready) return
    if (Date.now() - this.lastClientActivityAt > CONTROL_HEARTBEAT_TIMEOUT_MS) {
      this.dispose('heartbeat-timeout')
    }
  }

  private fail(code: string, message: string, recoverable: boolean): void {
    this.send({ type: 'voice.error', serverSeq: this.nextSeq(), code, message: message.slice(0, 512), recoverable })
    if (!recoverable) this.dispose(code)
  }

  private send(message: DirectVoiceServerControl): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private nextSeq(): number {
    this.serverSeq += 1
    if (this.continuity !== undefined) {
      this.continuity.serverSeq = this.serverSeq
      this.runtime.touch(this.continuity)
    }
    return this.serverSeq
  }
}

function createDirectState(): DirectVoiceContinuityState {
  return {
    backendEvents: new Map(),
    nextBackendEventSeq: 0,
    deliveredFunctionResults: new Set(),
  }
}

function pruneBackendEvents(events: Map<string, DirectBackendEventRecord>, targetSize: number): void {
  while (events.size > targetSize) {
    const acknowledged = [...events.entries()].find(([, event]) => event.acknowledged)
    if (acknowledged !== undefined) events.delete(acknowledged[0])
    else {
      const status = [...events.entries()].find(([, event]) => event.kind === 'status')
      if (status === undefined) return
      events.delete(status[0])
    }
  }
}

function rawDataLength(raw: WebSocket.RawData): number {
  if (raw instanceof ArrayBuffer) return raw.byteLength
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0)
  return raw.byteLength
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/(Bearer\s+|sk-|st-)[A-Za-z0-9._-]+/gi, '$1***').slice(0, 512)
}

function isTransientDisconnect(reason: string): boolean {
  return reason === 'client-disconnected' || reason === 'client-error'
}
