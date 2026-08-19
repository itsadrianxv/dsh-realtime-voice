import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_REALTIME_VOICE_MODEL,
  REALTIME_VOICE_MODELS,
  type RealtimeVoiceModel,
} from '../models.ts'

/** Host-side realtime voice configuration; secrets are references, never values. */
export interface VoiceConfig {
  endpoint: string
  apiKeyEnv: string
  model: RealtimeVoiceModel
  voice: string
  turnDetection: 'server_vad' | 'smart_turn'
  silenceDurationMs: number
  maxHistoryTurns: number
  maxConnections: number
  maxBinaryFrameBytes: number
  connectTimeoutMs: number
}

export const Config: z<VoiceConfig> = z.object({
  endpoint: z.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
  apiKeyEnv: z.string().default('DASHSCOPE_API_KEY'),
  model: z.union([REALTIME_VOICE_MODELS.flash, REALTIME_VOICE_MODELS.plus]).default(DEFAULT_REALTIME_VOICE_MODEL),
  voice: z.string().default('longanqian'),
  turnDetection: z.union(['server_vad', 'smart_turn']).default('smart_turn'),
  silenceDurationMs: z.natural().min(200).max(6000).default(600),
  maxHistoryTurns: z.natural().min(1).max(50).default(20),
  maxConnections: z.natural().min(1).max(32).default(4),
  maxBinaryFrameBytes: z.natural().min(1024).max(1024 * 1024).default(64 * 1024),
  connectTimeoutMs: z.natural().min(1000).max(60_000).default(15_000),
})
