import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/host/config.ts'
import { negotiateVoiceCapabilities, VoiceConnection } from '../src/host/voice-connection.ts'
import { AudioFrameKind, encodeAudioFrame } from '../src/protocol.ts'

class FakeBrowserSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = this.OPEN
  readonly sent: unknown[] = []

  bufferedAmount = 0

  send(value: unknown, _options?: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(value)
    callback?.()
  }

  close(): void {
    this.readyState = 3
  }
}

describe('full-duplex barge-in', () => {
  it.each(['web', 'wechat-mini-program'] as const)(
    'negotiates playbackDrainAck identically for %s',
    (platform) => {
      const base = {
        type: 'voice.hello',
        protocol: 'dsh.voice.v1',
        requestId: 'request-1',
        client: {
          platform,
          version: 'test',
          binaryWebSocket: true,
          playbackClear: true,
          pcmS16leVerified: true,
          foregroundOnly: false,
          duplex: 'best-effort',
        },
        target: { sessionId: 'session-1' },
        audio: {
          input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameDurationMs: 40 },
          output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameDurationMs: 40 },
        },
      } as const
      expect(negotiateVoiceCapabilities(base)).toMatchObject({
        playbackDrainAck: false,
        bargeIn: true,
        echoControl: 'host-gated',
      })
      expect(negotiateVoiceCapabilities({
        ...base,
        client: {
          ...base.client,
          playbackDrainAck: true,
          echoControl: 'client-filtered-preroll',
        },
      })).toMatchObject({ playbackDrainAck: true, bargeIn: true, echoControl: 'client-filtered-preroll' })
    },
  )

  it('reopens non-full-duplex upstream on cancel and ignores late cancelled audio', async () => {
    const socket = new FakeBrowserSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      hello: { client: { platform: string; duplex: string } }
      provider: { cancelResponse(): void; close(): void; appendAudio(value: Uint8Array): void }
      activeResponseId: string
      suppressInputDuringPlayback: boolean
      onProviderEvent(event: Record<string, unknown>): void
      interruptActiveResponse(reason: 'cancelled', cancelProvider: boolean): void
      receive(value: ArrayBuffer, binary: boolean): Promise<void>
    }
    const appendAudio = vi.fn()
    internal.hello = { client: { platform: 'wechat-mini-program', duplex: 'best-effort' } }
    internal.provider = { cancelResponse: vi.fn(), close: vi.fn(), appendAudio }
    internal.activeResponseId = 'response-one'

    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-one',
      delta: Buffer.alloc(1_920).toString('base64'),
    })
    expect(internal.suppressInputDuringPlayback).toBe(true)

    internal.interruptActiveResponse('cancelled', true)
    expect(internal.suppressInputDuringPlayback).toBe(false)

    internal.onProviderEvent({ type: 'response.audio.delta', response_id: 'response-one', delta: 'AAAA' })
    expect(internal.suppressInputDuringPlayback).toBe(false)
    await internal.receive(
      encodeAudioFrame(AudioFrameKind.ClientInput, 1, 0, new Uint8Array([0, 0])),
      true,
    )
    expect(appendAudio).toHaveBeenCalledTimes(1)
    connection.dispose()
  })

  it.each(['web', 'wechat-mini-program'] as const)(
    'uses the same drain-ACK contract for %s at identical negotiated capabilities',
    async (platform) => {
    const socket = new FakeBrowserSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      hello: { client: { platform: string; duplex: string; playbackDrainAck: boolean } }
      provider: { cancelResponse(): void; close(): void }
      activeResponseId?: string
      suppressInputDuringPlayback: boolean
      gatedOutputStreamId?: number
      onProviderEvent(event: Record<string, unknown>): void
      receive(value: Buffer, binary: boolean): Promise<void>
    }
    internal.hello = { client: { platform, duplex: 'best-effort', playbackDrainAck: true } }
    internal.provider = { cancelResponse: vi.fn(), close: vi.fn() }
    internal.activeResponseId = 'response-one'

      internal.onProviderEvent({
        type: 'response.audio.delta',
        response_id: 'response-one',
        delta: Buffer.alloc(1_920).toString('base64'),
      })
      internal.onProviderEvent({ type: 'response.done', response: { id: 'response-one' } })
      expect(internal.suppressInputDuringPlayback).toBe(true)
      expect(internal.gatedOutputStreamId).toBe(1)
      await vi.waitFor(() => {
        expect(socket.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value as string))).toContainEqual(
          expect.objectContaining({ type: 'voice.playback-finalize', streamId: 1 }),
        )
      })

    await internal.receive(Buffer.from(JSON.stringify({ type: 'voice.playback-drained', streamId: 1 })), false)
    expect(internal.suppressInputDuringPlayback).toBe(false)
    connection.dispose()
    },
  )

  it('never gates a client that declares real full duplex audio', () => {
    const socket = new FakeBrowserSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      hello: { client: { platform: string; duplex: string } }
      provider: { close(): void }
      activeResponseId: string
      suppressInputDuringPlayback: boolean
      onProviderEvent(event: Record<string, unknown>): void
    }
    internal.hello = { client: { platform: 'wechat-mini-program', duplex: 'full' } }
    internal.provider = { close: vi.fn() }
    internal.activeResponseId = 'response-one'

    internal.onProviderEvent({ type: 'response.audio.delta', response_id: 'response-one', delta: 'AAAA' })
    expect(internal.suppressInputDuringPlayback).toBe(false)
    connection.dispose()
  })

  it.each(['web', 'wechat-mini-program'] as const)(
    'uses the same bounded no-ACK fallback for %s when playbackDrainAck is undeclared',
    async (platform) => {
    vi.useFakeTimers()
    try {
      const socket = new FakeBrowserSocket()
      const connection = new VoiceConnection(
        { logger: { warn: vi.fn() } } as never,
        socket as never,
        {} as never,
        new Config({}),
        vi.fn(),
      )
      const internal = connection as unknown as {
        hello: { client: { platform: string; duplex: string } }
        provider: { close(): void }
        activeResponseId?: string
        suppressInputDuringPlayback: boolean
        onProviderEvent(event: Record<string, unknown>): void
      }
      internal.hello = { client: { platform, duplex: 'turn-based' } }
      internal.provider = { close: vi.fn() }
      internal.activeResponseId = 'legacy-response'

      internal.onProviderEvent({
        type: 'response.audio.delta',
        response_id: 'legacy-response',
        delta: Buffer.alloc(1_920).toString('base64'),
      })
      internal.onProviderEvent({ type: 'response.done', response: { id: 'legacy-response' } })
      expect(internal.suppressInputDuringPlayback).toBe(true)
      expect(socket.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value as string))).not.toContainEqual(
        expect.objectContaining({ type: 'voice.playback-finalize' }),
      )
      await vi.advanceTimersByTimeAsync(1_600)
      expect(internal.suppressInputDuringPlayback).toBe(false)
      connection.dispose()
    } finally {
      vi.useRealTimers()
    }
    },
  )

  it('accepts provider auto-cancellation and clears one active response exactly once when VAD starts', () => {
    const socket = new FakeBrowserSocket()
    const cancelResponse = vi.fn()
    const close = vi.fn()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      provider: { cancelResponse(): void; close(): void }
      activeResponseId: string
      onProviderEvent(event: { type: string }): void
    }
    internal.provider = { cancelResponse, close }
    internal.activeResponseId = 'response-one'

    internal.onProviderEvent({ type: 'input_audio_buffer.speech_started' })
    internal.onProviderEvent({ type: 'input_audio_buffer.speech_started' })

    expect(cancelResponse).not.toHaveBeenCalled()
    const messages = socket.sent
      .filter(value => typeof value === 'string')
      .map(value => JSON.parse(value as string) as { type: string; reason?: string })
    expect(messages.filter(message => message.type === 'voice.playback-clear')).toEqual([
      expect.objectContaining({ reason: 'barge-in' }),
    ])
    connection.dispose()
  })

  it('explicitly cancels when the browser detects speech before cloud VAD', () => {
    const socket = new FakeBrowserSocket()
    const cancelResponse = vi.fn()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      provider: { cancelResponse(): void; close(): void }
      activeResponseId: string
      interruptActiveResponse(reason: 'cancelled', cancelProvider: boolean): void
    }
    internal.provider = { cancelResponse, close: vi.fn() }
    internal.activeResponseId = 'response-one'

    internal.interruptActiveResponse('cancelled', true)
    internal.interruptActiveResponse('cancelled', true)

    expect(cancelResponse).toHaveBeenCalledTimes(1)
    connection.dispose()
  })

  it.each(['web', 'wechat-mini-program'] as const)(
    'forwards cancel-then-pre-roll without swallowing the first frame for a locally filtered %s client',
    async (platform) => {
      const socket = new FakeBrowserSocket()
      const connection = new VoiceConnection(
        { logger: { warn: vi.fn() } } as never,
        socket as never,
        {} as never,
        new Config({}),
        vi.fn(),
      )
      const appendAudio = vi.fn()
      const cancelResponse = vi.fn()
      const internal = connection as unknown as {
        hello: { client: { platform: string; duplex: string; playbackDrainAck: boolean; echoControl: string } }
        provider: { cancelResponse(): void; close(): void; appendAudio(value: Uint8Array): void }
        activeResponseId: string
        suppressInputDuringPlayback: boolean
        onProviderEvent(event: Record<string, unknown>): void
        receive(value: Buffer | ArrayBuffer, binary: boolean): Promise<void>
      }
      internal.hello = {
        client: {
          platform,
          duplex: 'best-effort',
          playbackDrainAck: true,
          echoControl: 'client-filtered-preroll',
        },
      }
      internal.provider = { cancelResponse, close: vi.fn(), appendAudio }
      internal.activeResponseId = 'response-one'

      internal.onProviderEvent({
        type: 'response.audio.delta',
        response_id: 'response-one',
        delta: Buffer.alloc(1_920, 7).toString('base64'),
      })
      expect(internal.suppressInputDuringPlayback).toBe(false)

      await internal.receive(Buffer.from(JSON.stringify({ type: 'voice.cancel-response' })), false)
      const preRoll = new Uint8Array([2, 0, 4, 0, 6, 0])
      await internal.receive(encodeAudioFrame(AudioFrameKind.ClientInput, 9, 0, preRoll), true)

      expect(cancelResponse).toHaveBeenCalledTimes(1)
      expect(appendAudio).toHaveBeenCalledTimes(1)
      expect([...appendAudio.mock.calls[0]![0] as Uint8Array]).toEqual([...preRoll])
      connection.dispose()
    },
  )

  it('does not self-interrupt when a locally filtered client uploads no pure playback echo', () => {
    const socket = new FakeBrowserSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const appendAudio = vi.fn()
    const cancelResponse = vi.fn()
    const internal = connection as unknown as {
      hello: { client: { duplex: string; playbackDrainAck: boolean; echoControl: string } }
      provider: { cancelResponse(): void; close(): void; appendAudio(value: Uint8Array): void }
      activeResponseId: string
      onProviderEvent(event: Record<string, unknown>): void
    }
    internal.hello = {
      client: { duplex: 'best-effort', playbackDrainAck: true, echoControl: 'client-filtered-preroll' },
    }
    internal.provider = { cancelResponse, close: vi.fn(), appendAudio }
    internal.activeResponseId = 'response-one'

    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-one',
      delta: Buffer.alloc(1_920, 3).toString('base64'),
    })

    expect(cancelResponse).not.toHaveBeenCalled()
    expect(appendAudio).not.toHaveBeenCalled()
    connection.dispose()
  })
})
