import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { Config, type VoiceConfig } from '../src/host/config.ts'
import { DashScopeRealtime, type RealtimeFunctionTool } from '../src/host/dashscope-realtime.ts'

const config: VoiceConfig = {
  endpoint: 'wss://example.invalid/api-ws/v1/realtime',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen-audio-3.0-realtime-plus',
  voice: 'longanqian',
  turnDetection: 'smart_turn',
  vadThreshold: 0.35,
  silenceDurationMs: 600,
  maxHistoryTurns: 20,
  maxConnections: 4,
  maxBinaryFrameBytes: 64 * 1024,
  connectTimeoutMs: 1_000,
}

const tools: readonly RealtimeFunctionTool[] = [{
  type: 'function',
  function: {
    name: 'handoff_to_dsh_agent',
    description: 'Execute real work.',
    parameters: { type: 'object', required: ['instruction'], properties: { instruction: { type: 'string' } } },
  },
}]

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  sent: Array<Record<string, unknown>> = []

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(message)
    if (message.type === 'session.update') queueMicrotask(() => this.event({ type: 'session.updated' }))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close', 1000, Buffer.from('closed'))
  }

  event(value: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(value)))
  }
}

function createProvider(
  socket: FakeSocket,
  selectedConfig: VoiceConfig = config,
  onEvent = vi.fn(),
): DashScopeRealtime {
  return new DashScopeRealtime(
    selectedConfig,
    'secret-not-logged',
    'voice instructions',
    tools,
    { onEvent },
    ((url, options) => {
      expect(options.headers?.Authorization).toBe('Bearer secret-not-logged')
      expect(url.searchParams.get('model')).toBe(selectedConfig.model)
      queueMicrotask(() => socket.event({ type: 'session.created' }))
      return socket as unknown as WebSocket
    }),
  )
}

describe('DashScope realtime provider', () => {
  it('configures the fast VAD profile and semantic Function Calling tools', async () => {
    const socket = new FakeSocket()
    const selected = new Config({})
    const provider = createProvider(socket, selected)
    await provider.connect()

    const update = socket.sent.find(message => message.type === 'session.update')
    const session = update?.session as Record<string, unknown>
    expect(session.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.35,
      silence_duration_ms: 500,
    })
    expect(session.tools).toEqual(tools)
    provider.close()
  })

  it('configures the quality model with smart turn detection', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()

    const update = socket.sent.find(message => message.type === 'session.update')
    expect(update).toMatchObject({
      session: {
        modalities: ['text', 'audio'],
        voice: 'longanqian',
        turn_detection: { type: 'smart_turn' },
        tools,
      },
    })
    provider.close()
  })

  it('returns Function Call output immediately and waits for the active response before continuing', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()
    socket.event({ type: 'response.created', response: { id: 'voice-response' } })

    provider.completeFunctionCall('call-1', { status: 'accepted', handoff_id: 'handoff-1' })
    expect(socket.sent.filter(message => message.type === 'conversation.item.create')).toContainEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({ status: 'accepted', handoff_id: 'handoff-1' }),
      },
    })
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(0)

    socket.event({ type: 'response.done', response: { id: 'voice-response' } })
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(1)
    provider.close()
  })

  it('queues and deduplicates authoritative DSH updates until Qwen is idle', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()
    socket.event({ type: 'response.created', response: { id: 'voice-response' } })
    provider.announceBackendEvent('dsh-event-42', '[COMPLETE] 打印完成。')
    provider.announceBackendEvent('dsh-event-42', '[COMPLETE] 打印完成。')
    expect(socket.sent.filter(message => message.type === 'conversation.item.create')).toHaveLength(0)

    socket.event({ type: 'response.done', response: { id: 'voice-response' } })
    const items = socket.sent.filter(message => message.type === 'conversation.item.create')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      item: {
        id: 'dsh-event-42',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: expect.stringContaining('[BACKEND]') }],
      },
    })
    provider.close()
  })

  it('does not create a follow-up response inside an active smart-turn speech window', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()
    socket.event({ type: 'response.created', response: { id: 'old-response' } })
    provider.completeFunctionCall('call-1', { status: 'accepted' })
    socket.event({ type: 'input_audio_buffer.speech_started' })
    socket.event({ type: 'response.done', response: { id: 'old-response', status: 'cancelled' } })
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(0)

    socket.event({ type: 'input_audio_buffer.speech_stopped' })
    socket.event({ type: 'response.created', response: { id: 'automatic-turn-response' } })
    socket.event({ type: 'response.done', response: { id: 'automatic-turn-response' } })
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(1)
    provider.close()
  })

  it('contains browser callback faults inside one provider event turn', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket, config, () => { throw new Error('browser socket disappeared') })
    await provider.connect()
    expect(() => socket.event({ type: 'response.audio.delta', delta: 'AA==' })).not.toThrow()
    provider.close()
  })

  it('forwards every accepted upstream PCM frame once, in order, without implicit throttling', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()
    const frames = [
      new Uint8Array([1, 0]),
      new Uint8Array([2, 0, 3, 0, 4, 0]),
      new Uint8Array(2_048).fill(7),
    ]

    for (const frame of frames) provider.appendAudio(frame)

    const appends = socket.sent.filter(message => message.type === 'input_audio_buffer.append')
    expect(appends).toHaveLength(frames.length)
    expect(appends.map(message => Buffer.from(message.audio as string, 'base64'))).toEqual(frames.map(Buffer.from))
    provider.close()
  })

  it('throws an explicit recoverable transport signal instead of silently dropping runaway upstream audio', async () => {
    const socket = new FakeSocket()
    const provider = createProvider(socket)
    await provider.connect()
    socket.bufferedAmount = 5 * 1024 * 1024

    expect(() => provider.appendAudio(new Uint8Array([1, 0]))).toThrow(/exceeded 4 MiB/)
    expect(socket.sent.filter(message => message.type === 'input_audio_buffer.append')).toHaveLength(0)
    provider.close()
  })
})
