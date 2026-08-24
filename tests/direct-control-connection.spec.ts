import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { VOICE_DIRECT_PROTOCOL } from '../src/direct-protocol.ts'
import { Config } from '../src/host/config.ts'
import { DirectControlConnection } from '../src/host/direct-control-connection.ts'
import { VoiceRuntime } from '../src/host/voice-runtime.ts'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = this.OPEN
  readonly sent: string[] = []

  send(value: string): void { this.sent.push(value) }
  close(): void { this.readyState = 3 }
  control(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
  binary(value = Buffer.alloc(1_024)): void { this.emit('message', value, true) }
  messages(): Array<Record<string, unknown>> { return this.sent.map(value => JSON.parse(value) as Record<string, unknown>) }
}

function asyncEmpty() {
  return (async function* () {})()
}

function fixture() {
  const prompt = vi.fn(async () => ({ result: { ok: true as const, value: {} } }))
  const context = {
    credentials: { resolve: vi.fn(async () => ({ value: 'sk-permanent-host-only' })) },
    logger: { warn: vi.fn() },
    apiProxy: {
      sessions: {
        list: vi.fn(async () => ({ result: { ok: true as const, value: { items: [{
          sessionId: 'session-1', running: false, blank: false, cwd: 'E:\\project', projections: { values: {} },
        }] } } })),
        history: vi.fn(async () => ({ result: { ok: true as const, value: { events: [] } } })),
        prompt,
        cancel: vi.fn(async () => ({ result: { ok: true as const, value: {} } })),
        updateQueue: vi.fn(async () => ({ result: { ok: true as const, value: {} } })),
      },
      events: { host: vi.fn(asyncEmpty), mux: vi.fn(asyncEmpty) },
      respond: vi.fn(async () => ({ accepted: true as const })),
    },
  }
  const issue = vi.fn(async () => ({
    token: `st-owner-${issue.mock.calls.length}`,
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
  }))
  const temporaryKeys = { issue }
  return { context, prompt, temporaryKeys, issue }
}

function hello(resume?: { voiceSessionId: string; lastServerSeq: number; lastBackendEventSeq: number }) {
  return {
    type: 'voice.hello',
    protocol: VOICE_DIRECT_PROTOCOL,
    requestId: crypto.randomUUID(),
    client: {
      platform: 'wechat-mini-program',
      version: 'direct-contract-test',
      foregroundOnly: true,
      websocketAuthorizationHeader: true,
    },
    target: { sessionId: 'session-1' },
    ...(resume === undefined ? {} : { resume }),
  }
}

function connection(socket: FakeSocket, runtime: VoiceRuntime, value: ReturnType<typeof fixture>) {
  return new DirectControlConnection(
    value.context as never,
    socket as never,
    {} as never,
    new Config({ endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' }),
    vi.fn(),
    runtime,
    value.temporaryKeys as never,
  )
}

async function ready(socket: FakeSocket) {
  await vi.waitFor(() => expect(socket.messages().some(message => message.type === 'voice.ready')).toBe(true))
  return socket.messages().find(message => message.type === 'voice.ready')!
}

describe('direct-media Host control plane', () => {
  it('offers a temporary bearer only to the atomic owner, uses a 32ms input cadence, and gives a contender only busy', async () => {
    const value = fixture()
    const runtime = new VoiceRuntime()
    const ownerSocket = new FakeSocket()
    connection(ownerSocket, runtime, value)
    ownerSocket.control(hello())
    const ownerReady = await ready(ownerSocket)
    expect(ownerReady).toMatchObject({
      protocol: VOICE_DIRECT_PROTOCOL,
      capabilities: { rawAudioOnControl: false },
      mediaOffer: {
        audio: { input: { recommendedChunkDurationMs: 32 } },
        authorization: { temporaryBearer: 'st-owner-1', authenticationPhase: 'handshake-only' },
      },
    })

    const contenderSocket = new FakeSocket()
    connection(contenderSocket, runtime, value)
    contenderSocket.control(hello())
    await vi.waitFor(() => expect(contenderSocket.messages().some(message => message.type === 'voice.busy')).toBe(true))
    expect(JSON.stringify(contenderSocket.messages())).not.toContain('temporaryBearer')
    expect(value.issue).toHaveBeenCalledTimes(1)
  })

  it('never accepts PCM on direct control and never mints a credential before a valid lease', async () => {
    const value = fixture()
    const socket = new FakeSocket()
    connection(socket, new VoiceRuntime(), value)
    socket.binary()
    await vi.waitFor(() => expect(socket.messages()).toContainEqual(expect.objectContaining({
      type: 'voice.error', code: 'raw-audio-forbidden', recoverable: false,
    })))
    expect(value.issue).not.toHaveBeenCalled()
    expect(socket.sent.every(frame => typeof frame === 'string')).toBe(true)
  })

  it('binds provider calls to the active media session, deduplicates callId, refreshes, and resumes within grace', async () => {
    const value = fixture()
    const runtime = new VoiceRuntime()
    const firstSocket = new FakeSocket()
    connection(firstSocket, runtime, value)
    firstSocket.control(hello())
    const firstReady = await ready(firstSocket)
    const offer = firstReady.mediaOffer as Record<string, unknown>
    const offerId = offer.offerId as string
    firstSocket.control({ type: 'media.connected', offerId, mediaSessionId: 'media-1', connectedAt: Date.now() })
    firstSocket.control({ type: 'media.connected', offerId, mediaSessionId: 'media-2', connectedAt: Date.now() })
    await vi.waitFor(() => expect(firstSocket.messages()).toContainEqual(expect.objectContaining({
      type: 'voice.error', code: 'bad-client-message', recoverable: true,
    })))
    const functionCall = {
      type: 'provider.function-call', offerId, mediaSessionId: 'media-1', callId: 'call-1',
      name: 'handoff_to_dsh_agent', arguments: JSON.stringify({ instruction: '打印读后感' }),
    }
    firstSocket.control(functionCall)
    firstSocket.control(functionCall)
    await vi.waitFor(() => expect(firstSocket.messages().filter(message => message.type === 'provider.function-result')).toHaveLength(1))
    expect(firstSocket.messages()).toContainEqual(expect.objectContaining({
      type: 'provider.function-result', offerId, mediaSessionId: 'media-1', callId: 'call-1',
    }))
    expect(value.prompt).toHaveBeenCalledTimes(1)

    firstSocket.control({ type: 'media.closed', offerId, mediaSessionId: 'media-1', code: 1000 })
    const internal = (runtime as unknown as { activeLease?: { voiceSessionId: string } }).activeLease
    const direct = (runtime as unknown as { calls: Map<string, { direct?: { lastOfferIssuedAt?: number } }> }).calls
      .get(internal!.voiceSessionId)!.direct!
    direct.lastOfferIssuedAt = 0
    let resolveRefresh!: (value: { token: string; expiresAt: number }) => void
    value.issue.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve }))
    firstSocket.control({ type: 'media.refresh', previousOfferId: offerId, reason: 'reconnect' })
    await vi.waitFor(() => expect(value.issue).toHaveBeenCalledTimes(2))

    const lastServerSeq = Math.max(...firstSocket.messages().map(message => Number(message.serverSeq ?? 0)))
    firstSocket.emit('close')
    const resumedSocket = new FakeSocket()
    connection(resumedSocket, runtime, value)
    resumedSocket.control(hello({
      voiceSessionId: firstReady.voiceSessionId as string,
      lastServerSeq,
      lastBackendEventSeq: 0,
    }))
    resolveRefresh({ token: 'st-shared-after-resume', expiresAt: Math.floor(Date.now() / 1_000) + 60 })
    const resumed = await ready(resumedSocket)
    expect(resumed.voiceSessionId).toBe(firstReady.voiceSessionId)
    expect(resumed).toMatchObject({ mediaOffer: { authorization: { temporaryBearer: 'st-shared-after-resume' } } })
    // The continuity-scoped in-flight issue is shared; the stale owner neither
    // mints another token nor overwrites the offer committed for the resumed owner.
    expect(value.issue).toHaveBeenCalledTimes(2)

    const resumedOfferId = (resumed.mediaOffer as Record<string, unknown>).offerId as string
    resumedSocket.control({ type: 'media.connected', offerId: resumedOfferId, mediaSessionId: 'media-2', connectedAt: Date.now() })
    resumedSocket.control({
      type: 'provider.function-call', offerId: resumedOfferId, mediaSessionId: 'media-2', callId: 'call-1',
      name: 'handoff_to_dsh_agent', arguments: JSON.stringify({ instruction: '这是新媒体会话的新任务' }),
    })
    await vi.waitFor(() => expect(value.prompt).toHaveBeenCalledTimes(2))
  })

  it('rejects a future backend cursor before issuing another credential', async () => {
    const value = fixture()
    const runtime = new VoiceRuntime()
    const socket = new FakeSocket()
    connection(socket, runtime, value)
    socket.control(hello())
    const firstReady = await ready(socket)
    const lastServerSeq = Math.max(...socket.messages().map(message => Number(message.serverSeq ?? 0)))
    socket.emit('close')

    const resumedSocket = new FakeSocket()
    connection(resumedSocket, runtime, value)
    resumedSocket.control(hello({
      voiceSessionId: firstReady.voiceSessionId as string,
      lastServerSeq,
      lastBackendEventSeq: 999,
    }))
    await vi.waitFor(() => expect(resumedSocket.messages()).toContainEqual(expect.objectContaining({
      type: 'voice.error', code: 'resume-backend-sequence-invalid', recoverable: false,
    })))
    expect(value.issue).toHaveBeenCalledTimes(1)
  })

  it('does not publish old durable turns as fresh backend completion events', async () => {
    const value = fixture()
    value.context.apiProxy.sessions.history.mockResolvedValue({ result: { ok: true as const, value: { events: [
      { event: { type: 'assistant/message', seq: 10, data: { turn: 1, message: { content: [{ type: 'text', text: '旧结果' }] } } } },
      { event: { type: 'turn/end', seq: 11, data: { turn: 1, reason: 'completed' } } },
    ] } } })
    const socket = new FakeSocket()
    connection(socket, new VoiceRuntime(), value)
    socket.control(hello())
    await ready(socket)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(socket.messages().filter(message => message.type === 'voice.backend-event')).toHaveLength(0)
  })

  it('deduplicates backend event ids and replays only unacknowledged events', async () => {
    const value = fixture()
    const runtime = new VoiceRuntime()
    const socket = new FakeSocket()
    const direct = connection(socket, runtime, value) as unknown as {
      recordBackendEvent(value: { eventId: string; kind: 'complete'; text: string }): void
      replayBackendEvents(): void
    }
    socket.control(hello())
    await ready(socket)
    direct.recordBackendEvent({ eventId: 'event-1', kind: 'complete', text: '完成' })
    direct.recordBackendEvent({ eventId: 'event-1', kind: 'complete', text: '完成' })
    direct.recordBackendEvent({ eventId: 'event-2', kind: 'complete', text: '又完成' })
    const beforeReplay = socket.messages().filter(message => message.type === 'voice.backend-event')
    expect(beforeReplay).toHaveLength(2)
    socket.control({ type: 'voice.backend-ack', eventId: 'event-1', eventSeq: 1 })
    direct.replayBackendEvents()
    const afterReplay = socket.messages().filter(message => message.type === 'voice.backend-event')
    expect(afterReplay).toHaveLength(3)
    expect(afterReplay[0]).toMatchObject({ eventId: 'event-1', eventSeq: 1 })
    expect(afterReplay[1]).toMatchObject({ eventId: 'event-2', eventSeq: 2 })
    expect(afterReplay[2]).toMatchObject({ eventId: 'event-2', eventSeq: 2 })
  })
})
