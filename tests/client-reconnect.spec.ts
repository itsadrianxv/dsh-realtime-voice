import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceCallController } from '../src/client/controller.ts'
import { VOICE_PROTOCOL } from '../src/protocol.ts'

class FakeBrowserSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeBrowserSocket[] = []

  readonly CONNECTING = FakeBrowserSocket.CONNECTING
  readonly OPEN = FakeBrowserSocket.OPEN
  readonly CLOSING = FakeBrowserSocket.CLOSING
  readonly CLOSED = FakeBrowserSocket.CLOSED
  readyState = FakeBrowserSocket.CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private readonly messageListeners = new Set<(event: MessageEvent) => void>()

  constructor(readonly url: string) {
    FakeBrowserSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.messageListeners.add(listener)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.messageListeners.delete(listener)
  }

  send(): void {}

  close(code = 1000, reason = ''): void {
    this.readyState = FakeBrowserSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }

  open(): void {
    this.readyState = FakeBrowserSocket.OPEN
    this.onopen?.()
  }

  message(value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent
    this.onmessage?.(event)
    for (const listener of this.messageListeners) listener(event)
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = FakeBrowserSocket.CLOSED
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

describe('browser voice reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeBrowserSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeBrowserSocket)
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:3080' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('recovers on a new socket and ignores a stale close from the old socket', async () => {
    const controller = new VoiceCallController(() => {})
    const connect = (controller as unknown as { connect(sessionId: string): Promise<void> }).connect.bind(controller)
    const firstConnect = connect('session-test')
    const first = FakeBrowserSocket.instances[0]!
    first.open()
    first.message(ready('voice-one'))
    await firstConnect
    expect(controller.getSnapshot().voiceSessionId).toBe('voice-one')

    first.drop()
    expect(controller.getSnapshot().phase).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1_000)
    const second = FakeBrowserSocket.instances[1]!
    second.open()
    second.message(ready('voice-two'))
    await vi.runAllTicks()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'listening', voiceSessionId: 'voice-two' })

    // A delayed duplicate close from socket one must not mark socket two dead.
    first.drop(1006, 'late-old-close')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'listening', voiceSessionId: 'voice-two' })
    await controller.dispose()
  })

  it('backs off for a provider rate limit and preserves the real upstream reason', async () => {
    const controller = new VoiceCallController(() => {})
    const connect = (controller as unknown as { connect(sessionId: string): Promise<void> }).connect.bind(controller)
    const attempt = connect('session-test')
    const first = FakeBrowserSocket.instances[0]!
    first.open()
    first.message({
      type: 'voice.error',
      serverSeq: 1,
      code: 'provider-disconnected',
      message: '百炼实时语音连接已断开（代码 1007：Requests rate limit exceeded）。',
      recoverable: true,
    })
    first.drop(1001, 'provider-disconnected')
    await expect(attempt).rejects.toThrow('Requests rate limit exceeded')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(FakeBrowserSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeBrowserSocket.instances).toHaveLength(2)
    await controller.dispose()
  })
})

function ready(voiceSessionId: string) {
  return {
    type: 'voice.ready',
    protocol: VOICE_PROTOCOL,
    voiceSessionId,
    serverSeq: 1,
    target: { sessionId: 'session-test', running: false },
    provider: { id: 'dashscope', model: 'test', voice: 'test', turnDetection: 'server_vad' },
    audio: {
      input: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameDurationMs: 40 },
      output: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1, frameDurationMs: 40 },
      maxBinaryFrameBytes: 65_536,
    },
    capabilities: { bargeIn: true, functionCalling: true, reconnect: true, persistentAgentTask: true },
  }
}
