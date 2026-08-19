import WebSocket, { type ClientOptions } from 'ws'
import type { VoiceConfig } from './config.ts'
import type { VoiceToolCall, VoiceToolResult } from './dsh-tools.ts'

export interface DashScopeRealtimeCallbacks {
  onEvent: (event: DashScopeServerEvent) => void
  onTool: (call: VoiceToolCall) => Promise<VoiceToolResult>
}

export type DashScopeServerEvent = Record<string, unknown> & { type: string }
export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket

interface PendingTool {
  call: VoiceToolCall
  result: Promise<VoiceToolResult>
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'start_task',
      description: '在当前 DeepSeek Harness 会话中开始一个新的 Agent 工作。',
      parameters: {
        type: 'object',
        properties: { instruction: { type: 'string', description: '交给编码 Agent 的完整任务要求。' } },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_task_message',
      description: '向当前 DSH 任务追加要求；运行中需要立刻改变方向时使用 steer。',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '要交给编码 Agent 的要求。' },
          mode: { type: 'string', enum: ['auto', 'queue', 'steer'], description: '默认 auto；steer 立即纠偏，queue 排入下一轮。' },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_status',
      description: '读取当前 DSH 会话是否运行以及最近的 Agent 结果。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: '停止当前 DSH 会话正在执行的 Agent 回合，但保留排队任务。',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const

/** One upstream Qwen-Audio Realtime session with contained Function Calling. */
export class DashScopeRealtime {
  private socket: WebSocket | undefined
  private readonly pendingTools = new Map<string, PendingTool[]>()
  private closed = false

  constructor(
    private readonly config: VoiceConfig,
    private readonly apiKey: string,
    private readonly instructions: string,
    private readonly callbacks: DashScopeRealtimeCallbacks,
    private readonly socketFactory: RealtimeSocketFactory = (url, options) => new WebSocket(url, options),
  ) {}

  /** Connect and resolve only after the upstream session accepts its configuration. */
  async connect(): Promise<void> {
    const url = new URL(this.config.endpoint)
    if (url.protocol !== 'wss:') throw new Error('DashScope realtime endpoint must use wss://')
    url.searchParams.set('model', this.config.model)
    const socket = this.socketFactory(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': '@harness-remote/dsh-realtime-voice',
      },
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('DashScope realtime connection timed out'))
        socket.close()
      }, this.config.connectTimeoutMs)
      let settled = false
      const fail = (error: Error): void => {
        clearTimeout(timeout)
        if (!settled) {
          settled = true
          reject(error)
        } else if (!this.closed) {
          this.callbacks.onEvent({ type: 'error', error: { type: 'transport_error', message: error.message } })
        }
      }
      socket.on('error', fail)
      socket.on('message', (raw) => {
        let event: DashScopeServerEvent
        try {
          event = JSON.parse(raw.toString()) as DashScopeServerEvent
        } catch {
          return
        }
        if (event.type === 'session.created') {
          this.send({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              voice: this.config.voice,
              instructions: this.instructions,
              input_audio_format: 'pcm',
              output_audio_format: 'pcm',
              max_history_turns: this.config.maxHistoryTurns,
              tools: TOOL_DEFINITIONS,
              turn_detection: this.config.turnDetection === 'server_vad'
                ? {
                    type: 'server_vad',
                    threshold: 0.5,
                    silence_duration_ms: this.config.silenceDurationMs,
                  }
                : { type: 'smart_turn' },
            },
          })
        }
        if (event.type === 'session.updated') {
          clearTimeout(timeout)
          settled = true
          resolve()
        }
        this.handleEvent(event)
      })
      socket.once('close', (code, reason) => {
        clearTimeout(timeout)
        if (!this.closed) this.callbacks.onEvent({
          type: 'transport.closed',
          code,
          reason: reason.toString(),
        })
      })
    })
  }

  appendAudio(pcm: Uint8Array): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.close(1000, 'voice session closed')
    this.socket = undefined
  }

  private handleEvent(event: DashScopeServerEvent): void {
    this.callbacks.onEvent(event)
    if (event.type === 'response.function_call_arguments.done') {
      const responseId = stringField(event, 'response_id')
      const call: VoiceToolCall = {
        callId: stringField(event, 'call_id'),
        name: stringField(event, 'name'),
        arguments: stringField(event, 'arguments'),
      }
      const pending = this.pendingTools.get(responseId) ?? []
      pending.push({ call, result: this.callbacks.onTool(call) })
      this.pendingTools.set(responseId, pending)
      return
    }
    if (event.type !== 'response.done') return
    const response = event.response as Record<string, unknown> | undefined
    const responseId = typeof response?.id === 'string' ? response.id : undefined
    if (responseId === undefined) return
    const pending = this.pendingTools.get(responseId)
    if (pending === undefined || pending.length === 0) return
    this.pendingTools.delete(responseId)
    void this.finishTools(pending).catch((error: unknown) => {
      if (!this.closed) this.callbacks.onEvent({
        type: 'error',
        error: {
          type: 'client_tool_error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    })
  }

  private async finishTools(pending: PendingTool[]): Promise<void> {
    const resolved = await Promise.all(pending.map(async item => ({
      call: item.call,
      result: await item.result,
    })))
    if (this.closed) return
    for (const item of resolved) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call.callId,
          output: item.result.output,
        },
      })
    }
    this.send({ type: 'response.create' })
  }

  private send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('DashScope realtime socket is not open')
    this.socket.send(JSON.stringify(message))
  }
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== 'string') throw new Error(`DashScope event is missing ${field}`)
  return result
}
