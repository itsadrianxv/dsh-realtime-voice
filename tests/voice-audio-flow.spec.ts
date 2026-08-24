import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/host/config.ts'
import { negotiateVoiceAudio, validateAudioNegotiation, VoiceConnection } from '../src/host/voice-connection.ts'
import {
  AudioFrameFlags,
  decodeAudioFrame,
  OUTPUT_FRAME_BYTES,
  type VoiceHello,
} from '../src/protocol.ts'

class FakeBrowserSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: unknown[] = []
  readonly pendingBinaryCallbacks: Array<(error?: Error) => void> = []
  closeCode: number | undefined
  closeReason: string | undefined

  constructor(private readonly holdBinaryCallbacks = false) {
    super()
  }

  send(value: unknown, options?: { binary?: boolean }, callback?: (error?: Error) => void): void {
    this.sent.push(value)
    if (options?.binary !== true || callback === undefined) return
    if (this.holdBinaryCallbacks) this.pendingBinaryCallbacks.push(callback)
    else callback()
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code
    this.closeReason = reason
    this.readyState = 3
  }
}

type VoiceInternals = {
  hello: { client: { duplex: string; playbackDrainAck?: boolean; echoControl?: string } }
  provider: { close(): void }
  activeResponseId?: string
  onProviderEvent(event: Record<string, unknown>): void
}

function createConnection(socket = new FakeBrowserSocket()): { connection: VoiceConnection; socket: FakeBrowserSocket; internal: VoiceInternals } {
  const connection = new VoiceConnection(
    { logger: { warn: vi.fn() } } as never,
    socket as never,
    {} as never,
    new Config({}),
    vi.fn(),
  )
  const internal = connection as unknown as VoiceInternals
  internal.hello = { client: { duplex: 'full', playbackDrainAck: true } }
  internal.provider = { close: vi.fn() }
  return { connection, socket, internal }
}

function controls(socket: FakeBrowserSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter(value => typeof value === 'string')
    .map(value => JSON.parse(value as string) as Record<string, unknown>)
}

function binaryFrames(socket: FakeBrowserSocket) {
  return socket.sent
    .filter(value => value instanceof ArrayBuffer)
    .map(value => decodeAudioFrame(value as ArrayBuffer))
}

describe('Host audio flow', () => {
  it('sends fixed packets with exact sequence/PTS and flushes the even tail before finalize', async () => {
    const { connection, socket, internal } = createConnection()
    const source = Uint8Array.from({ length: OUTPUT_FRAME_BYTES * 2 + 500 }, (_, index) => index % 239)
    internal.activeResponseId = 'response-a'
    for (const chunk of [source.slice(0, 100), source.slice(100, 2_600), source.slice(2_600)]) {
      internal.onProviderEvent({
        type: 'response.audio.delta',
        response_id: 'response-a',
        delta: Buffer.from(chunk).toString('base64'),
      })
    }
    internal.onProviderEvent({ type: 'response.done', response: { id: 'response-a' } })

    await vi.waitFor(() => expect(controls(socket).some(message => message.type === 'voice.playback-finalize')).toBe(true))
    const frames = binaryFrames(socket)
    expect(frames.map(frame => frame.payload.byteLength)).toEqual([OUTPUT_FRAME_BYTES, OUTPUT_FRAME_BYTES, 500])
    expect(frames.map(frame => frame.sequence)).toEqual([0, 1, 2])
    expect(frames.map(frame => frame.ptsMs)).toEqual([0, 40, 80])
    expect(frames[2]!.flags).toBe(AudioFrameFlags.EndOfStream)
    const restored = Buffer.concat(frames.map(frame => Buffer.from(frame.payload)))
    expect(restored).toEqual(Buffer.from(source))
    const finalizeIndex = socket.sent.findIndex(value => typeof value === 'string'
      && (JSON.parse(value as string) as { type?: string }).type === 'voice.playback-finalize')
    const lastBinaryIndex = socket.sent.findLastIndex(value => value instanceof ArrayBuffer)
    expect(finalizeIndex).toBeGreaterThan(lastBinaryIndex)
    connection.dispose()
  })

  it('waits for the binary send callback before playback-finalize', async () => {
    const heldSocket = new FakeBrowserSocket(true)
    const { connection, socket, internal } = createConnection(heldSocket)
    internal.activeResponseId = 'response-a'
    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-a',
      delta: Buffer.alloc(OUTPUT_FRAME_BYTES, 8).toString('base64'),
    })
    internal.onProviderEvent({ type: 'response.done', response: { id: 'response-a' } })
    await vi.waitFor(() => expect(socket.pendingBinaryCallbacks).toHaveLength(1))
    expect(controls(socket).some(message => message.type === 'voice.playback-finalize')).toBe(false)

    socket.pendingBinaryCallbacks.shift()!()
    await vi.waitFor(() => expect(controls(socket).some(message => message.type === 'voice.playback-finalize')).toBe(true))
    connection.dispose()
  })

  it('drops a cancelled response remainder and never joins it to the next response', async () => {
    const { connection, socket, internal } = createConnection()
    internal.activeResponseId = 'response-old'
    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-old',
      delta: Buffer.alloc(700, 1).toString('base64'),
    })
    ;(connection as unknown as { interruptActiveResponse(reason: 'cancelled', cancelProvider: boolean): void })
      .interruptActiveResponse('cancelled', false)

    internal.activeResponseId = 'response-new'
    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-new',
      delta: Buffer.alloc(OUTPUT_FRAME_BYTES, 9).toString('base64'),
    })
    internal.onProviderEvent({ type: 'response.done', response: { id: 'response-new' } })
    await vi.waitFor(() => expect(binaryFrames(socket)).toHaveLength(1))
    expect([...binaryFrames(socket)[0]!.payload]).toEqual([...Buffer.alloc(OUTPUT_FRAME_BYTES, 9)])
    connection.dispose()
  })

  it('disconnects recoverably instead of silently dropping when downlink backpressure is runaway', async () => {
    const overloaded = new FakeBrowserSocket()
    overloaded.bufferedAmount = 5 * 1024 * 1024
    const { connection, socket, internal } = createConnection(overloaded)
    internal.activeResponseId = 'response-a'
    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-a',
      delta: Buffer.alloc(OUTPUT_FRAME_BYTES, 4).toString('base64'),
    })
    internal.onProviderEvent({ type: 'response.done', response: { id: 'response-a' } })

    await vi.waitFor(() => expect(socket.closeReason).toBe('browser-audio-send-failed'))
    expect(controls(socket)).toContainEqual(expect.objectContaining({
      type: 'voice.error',
      code: 'browser-audio-backpressure',
      recoverable: true,
    }))
    expect(controls(socket).some(message => message.type === 'voice.playback-finalize')).toBe(false)
    connection.dispose()
  })

  it('queues ordinary socket jitter below the hard limit without dropping PCM', async () => {
    const jittered = new FakeBrowserSocket()
    jittered.bufferedAmount = 1024 * 1024
    const { connection, socket, internal } = createConnection(jittered)
    internal.activeResponseId = 'response-a'
    internal.onProviderEvent({
      type: 'response.audio.delta',
      response_id: 'response-a',
      delta: Buffer.alloc(OUTPUT_FRAME_BYTES, 5).toString('base64'),
    })
    internal.onProviderEvent({ type: 'response.done', response: { id: 'response-a' } })

    await vi.waitFor(() => expect(binaryFrames(socket)).toHaveLength(1))
    expect(binaryFrames(socket)[0]!.payload).toEqual(new Uint8Array(Buffer.alloc(OUTPUT_FRAME_BYTES, 5)))
    expect(socket.closeReason).toBeUndefined()
    connection.dispose()
  })

  it.each([
    ['web', 40],
    ['wechat-mini-program', 32],
  ] as const)('echoes the actual %s input frame duration while keeping 40 ms output packets', (platform, inputDuration) => {
    const hello = {
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
        input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameDurationMs: inputDuration },
        output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameDurationMs: 40 },
      },
    } as VoiceHello
    expect(negotiateVoiceAudio(hello, 65_536)).toEqual({
      input: hello.audio.input,
      output: hello.audio.output,
      maxBinaryFrameBytes: 65_536,
    })
  })

  it('accepts local echo filtering only with the complete client-neutral pre-roll contract', () => {
    const base = {
      type: 'voice.hello',
      protocol: 'dsh.voice.v1',
      requestId: 'request-1',
      client: {
        platform: 'unknown',
        version: 'test',
        binaryWebSocket: true,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: false,
        duplex: 'best-effort',
        playbackDrainAck: true,
        echoControl: 'client-filtered-preroll',
      },
      target: { sessionId: 'session-1' },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameDurationMs: 32 },
        output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameDurationMs: 40 },
      },
    } as VoiceHello

    expect(() => validateAudioNegotiation(base)).not.toThrow()
    expect(() => validateAudioNegotiation({
      ...base,
      client: { ...base.client, playbackDrainAck: false },
    })).toThrow(/requires best-effort duplex and playback drain acknowledgement/)
    expect(() => validateAudioNegotiation({
      ...base,
      client: { ...base.client, duplex: 'full' },
    })).toThrow(/requires best-effort duplex and playback drain acknowledgement/)
  })
})
