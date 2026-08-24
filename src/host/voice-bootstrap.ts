import type { VoiceConfig } from './config.ts'
import type { VoiceContinuityState } from './voice-runtime.ts'
import { VOICE_DIRECT_BOOTSTRAP, type DirectFunctionTool, type DirectMediaOffer } from '../direct-protocol.ts'

export const VOICE_FUNCTION_TOOLS: readonly DirectFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'handoff_to_dsh_agent',
      description: '把需要真实执行、访问 DSH 会话/项目/文件/应用/设备/网络或持续 Agent 工作的用户意图交给绑定的 DSH Agent。若 Agent 正在运行，调用会成为同一任务的实时纠正或补充。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction'],
        properties: {
          instruction: { type: 'string', minLength: 1, maxLength: 12_000 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_dsh_agent',
      description: '用户明确要求停止或取消绑定的 DSH Agent 工作时调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 1_000 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_dsh_approval',
      description: '回答 DSH 发出的操作审批。只有用户明确同意或拒绝之后才调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['approval_id', 'decision'],
        properties: {
          approval_id: { type: 'string', minLength: 1, maxLength: 256 },
          decision: { type: 'string', enum: ['allowed-once', 'rejected'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_dsh_question',
      description: '回答 DSH Agent 当前等待的结构化问题。必须使用收到的 request_id、问题 id 和选项标签。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['request_id', 'answers'],
        properties: {
          request_id: { type: 'string', minLength: 1, maxLength: 256 },
          answers: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 128 },
                selected: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 256 } },
                custom: { type: 'string', maxLength: 4_000 },
              },
            },
          },
        },
      },
    },
  },
]

export interface VoiceBootstrapStatus {
  running: boolean
  blank: boolean
  cwd?: string
  title?: string
  summary?: string
}

export function buildVoiceInstructions(
  status: VoiceBootstrapStatus,
  continuity?: Pick<VoiceContinuityState, 'userTranscript' | 'assistantTranscript'>,
): string {
  return [
    '你是 DeepSeek Harness 中一个统一助手的实时语音界面。你的首要目标是像自然通话一样快速、简洁地回应，并保持可随时打断。',
    '你负责低延迟交谈；绑定的 DSH Agent 负责真正执行任务。两者是同一个助手的对话面和执行面，不要向用户讲“后端”“工具路由”或内部实现。',
    '普通寒暄、解释、简单问答以及只依赖当前对话即可回答的内容，由你立即回答，不调用工具。',
    '凡是用户要求读取或修改文件、操作应用或设备、运行命令、写代码、查询绑定任务、使用项目上下文、联网研究、打印、发送，或任何需要真实执行和验证的工作，必须调用 handoff_to_dsh_agent。不要只教用户手动操作，也不要声称自己无法访问；让 DSH Agent 先实际尝试。',
    'handoff_to_dsh_agent 返回 accepted 只代表已受理，绝不代表完成。你可以立即自然确认“我来处理”，保持对话可继续；只有 [BACKEND][COMPLETE] 才能说任务已经完成。',
    'DSH 工作期间，用户的新约束、纠正或补充仍调用 handoff_to_dsh_agent；宿主会自动把它 steer 进同一正在执行的任务。用户要求停止时调用 cancel_dsh_agent。',
    '收到 [BACKEND][STATUS] 时，只在有帮助时用一句话播报进展；它不是终态。收到 [BACKEND][COMPLETE]、[FAILED] 或 [CANCELLED] 时，如实、简短播报权威结果，且不要重新提交已经结束的工作。',
    '收到 [BACKEND][NEEDS_APPROVAL] 时，简短说明要做的操作和风险并询问用户；得到明确同意或拒绝后调用 answer_dsh_approval。收到 [BACKEND][NEEDS_INPUT] 时自然提问，得到答案后调用 answer_dsh_question。此类回答不是新任务。',
    '如果一句话既包含可立即回答的问题又包含要执行的任务，可以先简短回答，再调用 handoff_to_dsh_agent；不要为了调用工具而长时间沉默。',
    `当前 DSH 状态：running=${String(status.running)}, blank=${String(status.blank)}.`,
    status.cwd === undefined ? '' : `当前项目目录：${status.cwd}.`,
    status.title === undefined ? '' : `当前会话标题：${status.title}.`,
    status.summary === undefined ? '当前没有可用的最近 Agent 摘要。' : `最近 Agent 内容：${status.summary}`,
    continuity?.userTranscript === '' || continuity?.userTranscript === undefined ? '' : `断线前用户最后一句：${continuity.userTranscript}`,
    continuity?.assistantTranscript === '' || continuity?.assistantTranscript === undefined ? '' : `断线前你最后一句：${continuity.assistantTranscript}`,
  ].filter(Boolean).join('\n')
}

export function buildDirectMediaOfferBootstrap(config: VoiceConfig, instructions: string): DirectMediaOffer['bootstrap'] {
  return {
    version: VOICE_DIRECT_BOOTSTRAP,
    event: {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: config.voice,
        instructions,
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        max_history_turns: config.maxHistoryTurns,
        tools: VOICE_FUNCTION_TOOLS,
        turn_detection: config.turnDetection === 'server_vad'
          ? { type: 'server_vad', threshold: config.vadThreshold, silence_duration_ms: config.silenceDurationMs }
          : { type: 'smart_turn' },
      },
    },
  }
}
