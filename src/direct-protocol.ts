import {
  VOICE_DIRECT_PROTOCOL,
  type VoiceApproval,
  type VoiceClientPlatform,
  type VoiceOccupancyStatus,
  type VoiceQuestion,
  type VoiceQuestionAnswer,
} from './protocol.ts'

export { VOICE_DIRECT_PROTOCOL }

export const VOICE_DIRECT_ROUTE = '/plugins/realtime-voice/v2/control' as const
export const VOICE_DIRECT_STATUS_ROUTE = '/plugins/realtime-voice/v2/status' as const
export const VOICE_DIRECT_BOOTSTRAP = 'dsh.voice.bootstrap.v1' as const
export const VOICE_DIRECT_TRANSCRIPT = 'dsh.voice.transcript.v1' as const
export const DIRECT_FUNCTION_ARGUMENT_MAX_BYTES = 16 * 1024
export const DIRECT_TRANSCRIPT_MAX_ITEMS = 16
export const DIRECT_TRANSCRIPT_MAX_TEXT_CHARS = 4_000
export const DIRECT_TRANSCRIPT_MAX_BYTES = 16 * 1024
export const DIRECT_DSH_FUNCTION_NAMES = [
  'handoff_to_dsh_agent',
  'cancel_dsh_agent',
  'answer_dsh_approval',
  'answer_dsh_question',
] as const
export type DirectDshFunctionName = typeof DIRECT_DSH_FUNCTION_NAMES[number]

export interface DirectVoiceHello {
  type: 'voice.hello'
  protocol: typeof VOICE_DIRECT_PROTOCOL
  /** Absence is backward-compatible connect behavior. */
  intent?: 'connect' | 'release'
  requestId: string
  client: {
    platform: VoiceClientPlatform
    version: string
    foregroundOnly: boolean
    /** Native/mini-program sockets can set Authorization; browser WebSocket cannot. */
    websocketAuthorizationHeader: boolean
  }
  target: { sessionId: string }
  resume?: {
    voiceSessionId: string
    lastServerSeq: number
    lastBackendEventSeq: number
    transcriptCheckpoint?: DirectTranscriptCheckpoint
  }
}

export interface DirectTranscriptCheckpoint {
  version: typeof VOICE_DIRECT_TRANSCRIPT
  /** Final text only, ordered oldest to newest. */
  items: DirectTranscriptItem[]
}

export interface DirectTranscriptItem {
  role: 'user' | 'assistant'
  text: string
  final: true
}

export type DirectTranscriptHistoryEvent = {
  type: 'conversation.item.create'
  previous_item_id?: string
  item: {
    id: string
    type: 'message'
    role: 'user'
    content: [{ type: 'input_text'; text: string }]
  } | {
    id: string
    type: 'message'
    role: 'assistant'
    content: [{ type: 'output_text'; text: string }]
  }
}

export interface DirectMediaOffer {
  offerId: string
  transport: 'websocket'
  endpoint: string
  authorization: {
    scheme: 'Bearer'
    temporaryBearer: string
    expiresAt: number
    authenticationPhase: 'handshake-only'
  }
  model: string
  voice: string
  audio: {
    input: { encoding: 'pcm_s16le'; sampleRate: 16_000; channels: 1; recommendedChunkDurationMs: 32 }
    output: { encoding: 'pcm_s16le'; sampleRate: 24_000; channels: 1; providerDeltaFraming: 'variable' }
  }
  bootstrap: {
    version: typeof VOICE_DIRECT_BOOTSTRAP
    event: {
      type: 'session.update'
      session: {
        modalities: ['text', 'audio']
        voice: string
        instructions: string
        input_audio_format: 'pcm'
        output_audio_format: 'pcm'
        max_history_turns: number
        tools: readonly DirectFunctionTool[]
        turn_detection: { type: 'server_vad'; threshold: number; silence_duration_ms: number }
          | { type: 'smart_turn' }
      }
    }
    transcript?: {
      version: typeof VOICE_DIRECT_TRANSCRIPT
      applyAfter: 'session.updated'
      acknowledgement: 'conversation.item.created'
      completeBefore: 'media.connected'
      events: DirectTranscriptHistoryEvent[]
    }
  }
}

export interface DirectFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface DirectClientMetrics {
  capturedFrames?: number
  playedFrames?: number
  droppedFrames?: number
  providerRttMs?: number
  uplinkJitterMs?: number
  downlinkJitterMs?: number
}

export type DirectVoiceClientControl = DirectVoiceHello
  | { type: 'voice.end'; reason?: string }
  | { type: 'voice.ping'; sentAt: number }
  | { type: 'media.refresh'; previousOfferId: string; reason: 'expiring' | 'reconnect' }
  | { type: 'media.connected'; offerId: string; mediaSessionId: string; connectedAt: number }
  | { type: 'media.closed'; offerId: string; mediaSessionId: string; code?: number; reason?: string }
  | { type: 'provider.function-call'; offerId: string; mediaSessionId: string; callId: string; name: string; arguments: string }
  | { type: 'voice.backend-ack'; eventId: string; eventSeq: number }
  | { type: 'voice.approval-answer'; approvalId: string; outcome: 'allowed-once' | 'rejected' }
  | { type: 'voice.question-answer'; requestId: string; answers: VoiceQuestionAnswer[] }
  | { type: 'client.metrics'; offerId?: string; mediaSessionId?: string; values: DirectClientMetrics }

export type DirectVoiceServerControl = {
  type: 'voice.ready'
  protocol: typeof VOICE_DIRECT_PROTOCOL
  voiceSessionId: string
  serverSeq: number
  target: { sessionId: string; running: boolean }
  capabilities: {
    directMedia: true
    reconnect: true
    functionBridge: true
    backendEventAck: true
    rawAudioOnControl: false
    transcriptCheckpoint: {
      version: typeof VOICE_DIRECT_TRANSCRIPT
      maxItems: typeof DIRECT_TRANSCRIPT_MAX_ITEMS
      maxTextChars: typeof DIRECT_TRANSCRIPT_MAX_TEXT_CHARS
      maxBytes: typeof DIRECT_TRANSCRIPT_MAX_BYTES
      completedTurnsOnly: true
    }
    resumeRelease: true
  }
  mediaOffer: DirectMediaOffer
} | { type: 'voice.busy'; serverSeq: number; occupancy: VoiceOccupancyStatus }
  | { type: 'media.offer'; serverSeq: number; mediaOffer: DirectMediaOffer }
  | { type: 'media.state'; serverSeq: number; offerId: string; mediaSessionId?: string; state: 'connected' | 'closed' }
  | { type: 'provider.function-result'; serverSeq: number; offerId: string; mediaSessionId: string; callId: string; output: unknown; cached: boolean }
  | { type: 'voice.backend-event'; serverSeq: number; eventId: string; eventSeq: number; kind: DirectBackendEventKind; text: string }
  | { type: 'voice.agent-status'; serverSeq: number; sessionId: string; running: boolean; summary?: string }
  | { type: 'voice.approval'; serverSeq: number; sessionId: string; status: 'pending' | 'resolved'; approval: VoiceApproval; outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { type: 'voice.question'; serverSeq: number; sessionId: string; status: 'pending' | 'resolved'; question: VoiceQuestion; outcome?: 'answered' | 'cancelled' }
  | { type: 'voice.pong'; serverSeq: number; sentAt: number }
  | { type: 'voice.error'; serverSeq: number; code: string; message: string; recoverable: boolean }
  | { type: 'voice.ended'; serverSeq: number; reason: string }

export type DirectBackendEventKind = 'status' | 'complete' | 'failed' | 'cancelled' | 'needs-approval' | 'needs-input'

export function isDirectVoiceClientControl(value: unknown): value is DirectVoiceClientControl {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'voice.hello') return isDirectHello(value)
  if (value.type === 'voice.end') return value.reason === undefined || isShortString(value.reason, 128)
  if (value.type === 'voice.ping') return isFiniteNumber(value.sentAt)
  if (value.type === 'media.refresh') {
    return isShortString(value.previousOfferId, 128) && (value.reason === 'expiring' || value.reason === 'reconnect')
  }
  if (value.type === 'media.connected') {
    return isShortString(value.offerId, 128) && isShortString(value.mediaSessionId, 256) && isFiniteNumber(value.connectedAt)
  }
  if (value.type === 'media.closed') {
    return isShortString(value.offerId, 128)
      && isShortString(value.mediaSessionId, 256)
      && (value.code === undefined || (Number.isSafeInteger(value.code) && (value.code as number) >= 0))
      && (value.reason === undefined || isShortString(value.reason, 256))
  }
  if (value.type === 'provider.function-call') {
    return isShortString(value.offerId, 128)
      && isShortString(value.mediaSessionId, 256)
      && isShortString(value.callId, 128)
      && isDirectDshFunctionName(value.name)
      && typeof value.arguments === 'string'
      && new TextEncoder().encode(value.arguments).byteLength <= DIRECT_FUNCTION_ARGUMENT_MAX_BYTES
      && isDirectFunctionArguments(value.name, value.arguments)
  }
  if (value.type === 'voice.backend-ack') {
    return isShortString(value.eventId, 256) && isNonNegativeInteger(value.eventSeq)
  }
  if (value.type === 'voice.approval-answer') {
    return isShortString(value.approvalId, 256) && (value.outcome === 'allowed-once' || value.outcome === 'rejected')
  }
  if (value.type === 'voice.question-answer') {
    return isShortString(value.requestId, 256) && isQuestionAnswers(value.answers)
  }
  if (value.type === 'client.metrics') return isMetricsMessage(value)
  return false
}

function isDirectHello(value: Record<string, unknown>): boolean {
  const client = value.client
  const target = value.target
  const resume = value.resume
  return value.protocol === VOICE_DIRECT_PROTOCOL
    && (value.intent === undefined || value.intent === 'connect' || value.intent === 'release')
    && isShortString(value.requestId, 128)
    && isRecord(client)
    && isPlatform(client.platform)
    && isShortString(client.version, 64)
    && typeof client.foregroundOnly === 'boolean'
    && typeof client.websocketAuthorizationHeader === 'boolean'
    && isRecord(target)
    && isShortString(target.sessionId, 256)
    && (resume === undefined || (
      isRecord(resume)
      && isShortString(resume.voiceSessionId, 256)
      && isNonNegativeInteger(resume.lastServerSeq)
      && isNonNegativeInteger(resume.lastBackendEventSeq)
      && (resume.transcriptCheckpoint === undefined || isDirectTranscriptCheckpoint(resume.transcriptCheckpoint))
    ))
    && (value.intent !== 'release' || (resume !== undefined && isRecord(resume) && resume.transcriptCheckpoint === undefined))
}

export function isDirectTranscriptCheckpoint(value: unknown): value is DirectTranscriptCheckpoint {
  if (!isRecord(value) || value.version !== VOICE_DIRECT_TRANSCRIPT || !Array.isArray(value.items)) return false
  if (Object.keys(value).some(key => key !== 'version' && key !== 'items')) return false
  if (value.items.length > DIRECT_TRANSCRIPT_MAX_ITEMS) return false
  let totalBytes = 0
  for (const item of value.items) {
    if (!isRecord(item) || Object.keys(item).some(key => key !== 'role' && key !== 'text' && key !== 'final')) return false
    if ((item.role !== 'user' && item.role !== 'assistant')
      || item.final !== true
      || typeof item.text !== 'string'
      || item.text.trim() === ''
      || item.text.length > DIRECT_TRANSCRIPT_MAX_TEXT_CHARS) return false
    totalBytes += new TextEncoder().encode(item.text).byteLength
    if (totalBytes > DIRECT_TRANSCRIPT_MAX_BYTES) return false
  }
  if (value.items.length % 2 !== 0) return false
  return value.items.every((item, index) => item.role === (index % 2 === 0 ? 'user' : 'assistant'))
}

function isMetricsMessage(value: Record<string, unknown>): boolean {
  if (value.offerId !== undefined && !isShortString(value.offerId, 128)) return false
  if (value.mediaSessionId !== undefined && !isShortString(value.mediaSessionId, 256)) return false
  if (!isRecord(value.values)) return false
  const allowed = new Set(['capturedFrames', 'playedFrames', 'droppedFrames', 'providerRttMs', 'uplinkJitterMs', 'downlinkJitterMs'])
  const entries = Object.entries(value.values)
  return entries.length > 0
    && entries.every(([key, metric]) => allowed.has(key) && isFiniteNumber(metric) && (metric as number) >= 0)
}

function isQuestionAnswers(value: unknown): value is VoiceQuestionAnswer[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every((entry) => {
    if (!isRecord(entry)) return false
    const keys = Object.keys(entry)
    return keys.every(key => key === 'id' || key === 'selected' || key === 'custom')
      && isShortString(entry.id, 128)
      && Array.isArray(entry.selected)
      && entry.selected.length <= 16
      && entry.selected.every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)
      && (entry.custom === undefined || (typeof entry.custom === 'string' && entry.custom.length <= 4_000))
  })
}

export function isDirectDshFunctionName(value: unknown): value is DirectDshFunctionName {
  return typeof value === 'string' && (DIRECT_DSH_FUNCTION_NAMES as readonly string[]).includes(value)
}

export function isDirectFunctionArguments(name: DirectDshFunctionName, value: string): boolean {
  let parsed: unknown
  try { parsed = value.trim() === '' ? {} : JSON.parse(value) } catch { return false }
  if (!isRecord(parsed)) return false
  const keys = Object.keys(parsed)
  if (name === 'handoff_to_dsh_agent') {
    return keys.every(key => key === 'instruction') && isShortString(parsed.instruction, 12_000)
  }
  if (name === 'cancel_dsh_agent') {
    return keys.every(key => key === 'reason')
      && (parsed.reason === undefined || (typeof parsed.reason === 'string' && parsed.reason.length <= 1_000))
  }
  if (name === 'answer_dsh_approval') {
    return keys.every(key => key === 'approval_id' || key === 'decision')
      && isShortString(parsed.approval_id, 256)
      && (parsed.decision === 'allowed-once' || parsed.decision === 'rejected')
  }
  return keys.every(key => key === 'request_id' || key === 'answers')
    && isShortString(parsed.request_id, 256)
    && isQuestionAnswers(parsed.answers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShortString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlatform(value: unknown): value is VoiceClientPlatform {
  return value === 'web' || value === 'wechat-mini-program' || value === 'ios' || value === 'android' || value === 'unknown'
}
