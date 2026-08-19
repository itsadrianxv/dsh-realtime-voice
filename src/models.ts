/** Realtime voice models supported by the built-in DashScope provider. */
export const REALTIME_VOICE_MODELS = {
  flash: 'qwen-audio-3.0-realtime-flash',
  plus: 'qwen-audio-3.0-realtime-plus',
} as const

export type RealtimeVoiceModel = typeof REALTIME_VOICE_MODELS[keyof typeof REALTIME_VOICE_MODELS]

export const REALTIME_VOICE_TURN_DETECTION = {
  fast: 'server_vad',
  semantic: 'smart_turn',
} as const

export type RealtimeVoiceTurnDetection =
  typeof REALTIME_VOICE_TURN_DETECTION[keyof typeof REALTIME_VOICE_TURN_DETECTION]

export const DEFAULT_REALTIME_VOICE_MODEL: RealtimeVoiceModel = REALTIME_VOICE_MODELS.plus
export const DEFAULT_REALTIME_VOICE_TURN_DETECTION: RealtimeVoiceTurnDetection = REALTIME_VOICE_TURN_DETECTION.fast
export const REALTIME_VOICE_SETTINGS_NAMESPACE = 'realtime-voice' as const

export function isRealtimeVoiceModel(value: unknown): value is RealtimeVoiceModel {
  return value === REALTIME_VOICE_MODELS.flash || value === REALTIME_VOICE_MODELS.plus
}

export function isRealtimeVoiceTurnDetection(value: unknown): value is RealtimeVoiceTurnDetection {
  return value === REALTIME_VOICE_TURN_DETECTION.fast || value === REALTIME_VOICE_TURN_DETECTION.semantic
}

export function realtimeVoiceModelLabel(model: string | undefined): string {
  if (model === REALTIME_VOICE_MODELS.flash) return 'Flash · 经济低延迟'
  if (model === REALTIME_VOICE_MODELS.plus) return 'Plus · 高质量'
  return model ?? '未知模型'
}

export function realtimeVoiceTurnDetectionLabel(mode: string | undefined): string {
  if (mode === REALTIME_VOICE_TURN_DETECTION.fast) return '快速声学打断'
  if (mode === REALTIME_VOICE_TURN_DETECTION.semantic) return '智能语义轮次'
  return mode ?? '未知打断模式'
}
