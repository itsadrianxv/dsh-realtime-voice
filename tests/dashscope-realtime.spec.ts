import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { Config, type VoiceConfig } from '../src/host/config.ts'
import { DashScopeRealtime } from '../src/host/dashscope-realtime.ts'

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

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN
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

describe('DashScope realtime provider', () => {
  it('configures the fast VAD profile with the requested acoustic thresholds', async () => {
    const socket = new FakeSocket()
    const provider = new DashScopeRealtime(
      new Config({}),
      'secret-not-logged',
      'voice instructions',
      { onEvent: vi.fn() },
      (() => {
        queueMicrotask(() => socket.event({ type: 'session.created' }))
        return socket as unknown as WebSocket
      }),
    )

    await provider.connect()
    const update = socket.sent.find(message => message.type === 'session.update')
    expect((update?.session as Record<string, unknown>).turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.35,
      silence_duration_ms: 500,
    })
    provider.close()
  })

  it('configures the quality model as a speech-only session without provider tools', async () => {
    const socket = new FakeSocket()
    const provider = new DashScopeRealtime(
      config,
      'secret-not-logged',
      'voice instructions',
      { onEvent: vi.fn() },
      ((url, options) => {
        expect(url.searchParams.get('model')).toBe('qwen-audio-3.0-realtime-plus')
        expect(options.headers?.Authorization).toBe('Bearer secret-not-logged')
        queueMicrotask(() => socket.event({ type: 'session.created' }))
        return socket as unknown as WebSocket
      }),
    )

    await provider.connect()
    const update = socket.sent.find(message => message.type === 'session.update')
    expect(update).toBeDefined()
    expect((update?.session as Record<string, unknown>).tools).toBeUndefined()
    expect(JSON.stringify(update)).not.toContain('function')
    provider.close()
  })

  it('queues a durable Agent result while speaking and announces it exactly once after the response', async () => {
    const socket = new FakeSocket()
    const provider = new DashScopeRealtime(
      config,
      'secret-not-logged',
      'voice instructions',
      { onEvent: vi.fn() },
      (() => {
        queueMicrotask(() => socket.event({ type: 'session.created' }))
        return socket as unknown as WebSocket
      }),
    )
    await provider.connect()
    socket.event({ type: 'response.created', response: { id: 'voice-response' } })
    provider.announceAgentResult('Agent finished successfully', 42)
    provider.announceAgentResult('Agent finished successfully', 42)
    expect(socket.sent.filter(message => message.type === 'conversation.item.create')).toHaveLength(0)

    socket.event({ type: 'response.done', response: { id: 'voice-response' } })
    const items = socket.sent.filter(message => message.type === 'conversation.item.create')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      item: {
        id: 'dsh_agent_42',
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text' }],
      },
    })
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(1)
    provider.close()
  })

  it('contains browser callback faults inside one provider event turn', async () => {
    const socket = new FakeSocket()
    const provider = new DashScopeRealtime(
      config,
      'secret-not-logged',
      'voice instructions',
      {
        onEvent: () => { throw new Error('browser socket disappeared') },
      },
      (() => {
        queueMicrotask(() => socket.event({ type: 'session.created' }))
        return socket as unknown as WebSocket
      }),
    )
    await provider.connect()
    expect(() => socket.event({ type: 'response.audio.delta', delta: 'AA==' })).not.toThrow()
    provider.close()
  })
})
