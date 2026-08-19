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

interface AgentAnnouncement {
  eventSeq: number
  text: string
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
      name: 'list_sessions',
      description: '按标题或工作区关键词检索 DSH 会话。用户提到其他项目、线程或会话时先调用它，再用返回的 sessionId 读取回复。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '会话标题或主题关键词，例如“做成微信小程序”。' },
          workspace: { type: 'string', description: '工作区目录或名称关键词，例如“deepseek-harness”。' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回多少条，默认 5。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_latest_reply',
      description: '读取指定 DSH 会话最后一条 Agent 回复；sessionId 必须来自 list_sessions 的结果。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '准确的 DSH sessionId。' },
        },
        required: ['sessionId'],
      },
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
  private readonly queuedAgentAnnouncements: AgentAnnouncement[] = []
  private readonly announcedEventSeqs = new Set<number>()
  private responseActive = false
  private responseRequested = false
  private inputSpeechActive = false
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

  /** Feed a completed durable DSH turn back into the short-lived voice context and speak it once. */
  announceAgentResult(text: string, eventSeq: number): void {
    if (this.closed || this.announcedEventSeqs.has(eventSeq)) return
    this.announcedEventSeqs.add(eventSeq)
    this.queuedAgentAnnouncements.push({ eventSeq, text: text.slice(0, 2_000) })
    if (this.queuedAgentAnnouncements.length > 3) this.queuedAgentAnnouncements.shift()
    this.drainAgentAnnouncements()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.close(1000, 'voice session closed')
    this.socket = undefined
  }

  private handleEvent(event: DashScopeServerEvent): void {
    this.callbacks.onEvent(event)
    if (event.type === 'input_audio_buffer.speech_started') {
      this.inputSpeechActive = true
      return
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.inputSpeechActive = false
      return
    }
    if (event.type === 'response.created') {
      this.responseActive = true
      this.responseRequested = false
      return
    }
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
    this.responseActive = false
    this.responseRequested = false
    const response = event.response as Record<string, unknown> | undefined
    const responseId = typeof response?.id === 'string' ? response.id : undefined
    if (responseId === undefined) {
      this.drainAgentAnnouncements()
      return
    }
    const pending = this.pendingTools.get(responseId)
    if (pending === undefined || pending.length === 0) {
      this.drainAgentAnnouncements()
      return
    }
    this.pendingTools.delete(responseId)
    // Reserve the next response while DSH executes the tool so a simultaneous
    // Agent-completion announcement cannot race the function result follow-up.
    this.responseRequested = true
    void this.finishTools(pending).catch((error: unknown) => {
      this.responseRequested = false
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
    this.requestResponse()
  }

  private drainAgentAnnouncements(): void {
    if (this.closed
      || this.inputSpeechActive
      || this.responseActive
      || this.responseRequested
      || this.queuedAgentAnnouncements.length === 0) return
    const announcement = this.queuedAgentAnnouncements.shift()!
    this.send({
      type: 'conversation.item.create',
      item: {
        id: `dsh_agent_${announcement.eventSeq}`,
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: `DSH Agent 刚完成了一次工作。以下是 DSH 会话中的权威最终回复。请用自然、简短的中文主动向用户播报结果，不要重复提交任务：\n${announcement.text}`,
        }],
      },
    })
    this.requestResponse()
  }

  private requestResponse(): void {
    this.responseRequested = true
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
