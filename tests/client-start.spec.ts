import { afterEach, describe, expect, it, vi } from 'vitest'
import { isVoiceDialUnavailable, VoiceCallController, type VoiceSnapshot } from '../src/client/controller.ts'
import { VOICE_PROTOCOL } from '../src/protocol.ts'

describe('browser voice start arbitration', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('claims the local start slot before the asynchronous occupancy preflight', async () => {
    let resolveFetch!: (value: unknown) => void
    const fetchPromise = new Promise(resolve => { resolveFetch = resolve })
    const fetch = vi.fn(() => fetchPromise)
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('fetch', fetch)

    const controller = new VoiceCallController()
    const first = controller.start('session-one')
    const duplicate = controller.start('session-one')

    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', sessionId: 'session-one' })
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveFetch({
      ok: true,
      json: async () => ({ protocol: 'dsh.voice.v1', active: true }),
    })
    await Promise.all([first, duplicate])
    expect(controller.getSnapshot().phase).toBe('error')
    await controller.dispose()
  })

  it('does not reinterpret its ready transport or retained resume context as a remote owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => occupancyResponse(true, 'web')))
    const controller = new VoiceCallController()
    const internal = controller as unknown as {
      update(snapshot: VoiceSnapshot): void
      receive(event: MessageEvent): void
      refreshPresence(): Promise<unknown>
      fail(message: string, preserveResume: boolean): Promise<void>
    }
    internal.update(baseSnapshot({ phase: 'connecting', sessionId: 'session-one' }))
    internal.receive({ data: JSON.stringify(ready('voice-owned-by-this-webui', 1)) } as MessageEvent)
    await internal.refreshPresence()

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'listening',
      voiceSessionId: 'voice-owned-by-this-webui',
      occupancy: { active: true },
    })
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(false)

    await internal.fail('重连次数已耗尽', true)
    await internal.refreshPresence()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      sessionId: 'session-one',
      voiceSessionId: 'voice-owned-by-this-webui',
      occupancy: { active: true },
    })
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(false)
    await controller.dispose()
  })

  it('disables a fresh dial for remote occupancy and re-enables it after grace expires', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(occupancyResponse(true, 'wechat-mini-program'))
      .mockResolvedValueOnce(occupancyResponse(false))
    vi.stubGlobal('fetch', fetch)
    const controller = new VoiceCallController()
    const refreshPresence = (controller as unknown as { refreshPresence(): Promise<unknown> }).refreshPresence.bind(controller)

    await refreshPresence()
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(true)
    expect(controller.getSnapshot().occupancy).toMatchObject({
      active: true,
      owner: { platform: 'wechat-mini-program' },
    })

    await refreshPresence()
    expect(controller.getSnapshot().occupancy).toEqual({ protocol: VOICE_PROTOCOL, active: false })
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(false)
    await controller.dispose()
  })

  it('never treats a failed pre-ready attempt as locally owned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => occupancyResponse(true, 'wechat-mini-program')))
    const controller = new VoiceCallController()
    const internal = controller as unknown as {
      update(snapshot: VoiceSnapshot): void
      fail(message: string, preserveResume: boolean): Promise<void>
      refreshPresence(): Promise<unknown>
    }
    internal.update(baseSnapshot({ phase: 'connecting', sessionId: 'session-one' }))
    await internal.fail('voice.start failed before ready', true)
    await internal.refreshPresence()

    expect(controller.getSnapshot()).not.toHaveProperty('voiceSessionId')
    expect(controller.getSnapshot().phase).toBe('error')
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(true)
    await controller.dispose()
  })

  it('honors a lower-sequence Host busy decision for a rejected resume attempt', async () => {
    const controller = new VoiceCallController()
    const internal = controller as unknown as {
      update(snapshot: VoiceSnapshot): void
      receive(event: MessageEvent): void
      lastServerSeq: number
    }
    internal.update(baseSnapshot({
      phase: 'reconnecting',
      sessionId: 'session-one',
      voiceSessionId: 'locally-held-resume-token',
    }))
    internal.lastServerSeq = 42
    internal.receive({
      data: JSON.stringify({
        type: 'voice.busy',
        serverSeq: 1,
        occupancy: {
          protocol: VOICE_PROTOCOL,
          active: true,
          owner: {
            platform: 'wechat-mini-program',
            clientVersion: 'mini-test',
            sessionId: 'session-two',
            startedAt: 1,
            lastSeenAt: 2,
          },
        },
      }),
    } as MessageEvent)
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('error'))

    expect(controller.getSnapshot()).not.toHaveProperty('voiceSessionId')
    expect(controller.getSnapshot().occupancy).toMatchObject({ active: true })
    expect(isVoiceDialUnavailable(controller.getSnapshot())).toBe(true)
    await controller.dispose()
  })
})

function baseSnapshot(overrides: Partial<VoiceSnapshot> = {}): VoiceSnapshot {
  return {
    phase: 'idle',
    muted: false,
    userTranscript: '',
    assistantTranscript: '',
    agentRunning: false,
    elapsedSeconds: 0,
    ...overrides,
  }
}

function occupancyResponse(active: boolean, platform?: 'web' | 'wechat-mini-program') {
  return {
    ok: true,
    json: async () => active
      ? {
          protocol: VOICE_PROTOCOL,
          active: true,
          owner: {
            platform: platform ?? 'web',
            clientVersion: 'test',
            sessionId: 'session-one',
            startedAt: 1,
            lastSeenAt: 2,
          },
        }
      : { protocol: VOICE_PROTOCOL, active: false },
  }
}

function ready(voiceSessionId: string, serverSeq: number) {
  return {
    type: 'voice.ready',
    protocol: VOICE_PROTOCOL,
    voiceSessionId,
    serverSeq,
    target: { sessionId: 'session-one', running: false },
    provider: { id: 'dashscope', model: 'test', voice: 'test', turnDetection: 'server_vad' },
    audio: {
      input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameDurationMs: 40 },
      output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameDurationMs: 40 },
      maxBinaryFrameBytes: 65_536,
    },
    capabilities: {
      bargeIn: true,
      functionCalling: true,
      reconnect: true,
      persistentAgentTask: true,
      playbackDrainAck: true,
    },
  }
}
