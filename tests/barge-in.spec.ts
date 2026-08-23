import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/host/config.ts'
import { VoiceConnection } from '../src/host/voice-connection.ts'

class FakeBrowserSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = this.OPEN
  readonly sent: string[] = []

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
  }
}

describe('full-duplex barge-in', () => {
  it('gates Mini Program upstream audio while model playback is active', () => {
    const socket = new FakeBrowserSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
    )
    const internal = connection as unknown as {
      hello: { client: { platform: string } }
      provider: { cancelResponse(): void; close(): void }
      activeResponseId: string
      suppressMiniInputAudio: boolean
      onProviderEvent(event: Record<string, unknown>): void
      interruptActiveResponse(reason: 'cancelled', cancelProvider: boolean): void
    }
    internal.hello = { client: { platform: 'wechat-mini-program' } }
    internal.provider = { cancelResponse: vi.fn(), close: vi.fn() }
    internal.activeResponseId = 'response-one'

    internal.onProviderEvent({ type: 'response.audio.delta', response_id: 'response-one', delta: 'AAAA' })
    expect(internal.suppressMiniInputAudio).toBe(true)

    internal.suppressMiniInputAudio = false
    internal.interruptActiveResponse('cancelled', true)
    expect(internal.suppressMiniInputAudio).toBe(false)
    connection.dispose()
  })

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
    const messages = socket.sent.map(value => JSON.parse(value) as { type: string; reason?: string })
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
})
