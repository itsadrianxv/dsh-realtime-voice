import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { VoiceConfig } from '../src/host/config.ts'
import { DashScopeRealtime } from '../src/host/dashscope-realtime.ts'

const config: VoiceConfig = {
  endpoint: 'wss://example.invalid/api-ws/v1/realtime',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen-audio-3.0-realtime-plus',
  voice: 'longanqian',
  turnDetection: 'smart_turn',
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
  it('configures the quality model and returns all tool outputs before one follow-up response', async () => {
    const socket = new FakeSocket()
    const onTool = vi.fn(async (call) => ({ ok: true, output: JSON.stringify({ ok: true, callId: call.callId }) }))
    const provider = new DashScopeRealtime(
      config,
      'secret-not-logged',
      'voice instructions',
      { onEvent: vi.fn(), onTool },
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
    expect((update?.session as Record<string, unknown>).tools).toHaveLength(6)

    socket.event({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-1',
      name: 'get_task_status',
      arguments: '{}',
    })
    socket.event({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-2',
      name: 'send_task_message',
      arguments: JSON.stringify({ instruction: 'continue' }),
    })
    socket.event({ type: 'response.done', response: { id: 'response-1' } })
    await vi.waitFor(() => {
      expect(socket.sent.filter(message => message.type === 'conversation.item.create')).toHaveLength(2)
    })
    expect(onTool).toHaveBeenCalledTimes(2)
    expect(socket.sent.filter(message => message.type === 'response.create')).toHaveLength(1)
    provider.close()
  })

  it('queues a durable Agent result while speaking and announces it exactly once after the response', async () => {
    const socket = new FakeSocket()
    const provider = new DashScopeRealtime(
      config,
      'secret-not-logged',
      'voice instructions',
      { onEvent: vi.fn(), onTool: vi.fn() },
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
        onTool: vi.fn(),
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
