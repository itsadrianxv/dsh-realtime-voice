/** Versioned client-neutral wire contract shared by WebUI and WeChat Mini Program clients. */

export const VOICE_PROTOCOL = 'dsh.voice.v1' as const
export const VOICE_PROTOCOL_VERSION = 1 as const
export const VOICE_ROUTE = '/plugins/realtime-voice/v1' as const

export const INPUT_SAMPLE_RATE = 16_000 as const
export const OUTPUT_SAMPLE_RATE = 24_000 as const
export const AUDIO_CHANNELS = 1 as const

const AUDIO_MAGIC = [0x44, 0x53, 0x56, 0x31] as const // ASCII "DSV1"
export const AUDIO_HEADER_BYTES = 24 as const

export type VoiceClientPlatform = 'web' | 'wechat-mini-program' | 'ios' | 'android' | 'unknown'
export type VoicePhase =
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'agent-working'
  | 'speaking'
  | 'reconnecting'
  | 'ending'

export interface PcmAudioSpec {
  encoding: 'pcm_s16le'
  sampleRate: number
  channels: 1
  frameDurationMs: number
}

export interface VoiceHello {
  type: 'voice.hello'
  protocol: typeof VOICE_PROTOCOL
  requestId: string
  client: {
    platform: VoiceClientPlatform
    version: string
    binaryWebSocket: true
    playbackClear: true
    /** Mini Program clients must only set this after a real-device PCM layout probe. */
    pcmS16leVerified: true
    foregroundOnly: boolean
    duplex: 'full' | 'best-effort' | 'turn-based'
  }
  target: { sessionId: string }
  audio: {
    input: PcmAudioSpec
    output: PcmAudioSpec
  }
  resume?: {
    voiceSessionId: string
    lastServerSeq: number
  }
}

export type VoiceClientControl = VoiceHello
  | { type: 'voice.end'; reason?: string }
  | { type: 'voice.cancel-response' }
  | { type: 'voice.commit' }
  | { type: 'voice.ping'; sentAt: number }

export interface VoiceReady {
  type: 'voice.ready'
  protocol: typeof VOICE_PROTOCOL
  voiceSessionId: string
  serverSeq: number
  target: { sessionId: string; running: boolean }
  provider: { id: 'dashscope'; model: string; voice: string; turnDetection: 'server_vad' | 'smart_turn' }
  audio: {
    input: PcmAudioSpec
    output: PcmAudioSpec
    maxBinaryFrameBytes: number
  }
  capabilities: {
    bargeIn: true
    functionCalling: boolean
    reconnect: true
    persistentAgentTask: true
  }
}

export type VoiceServerControl = VoiceReady
  | { type: 'voice.state'; serverSeq: number; phase: VoicePhase }
  | {
    type: 'voice.transcript'
    serverSeq: number
    role: 'user' | 'assistant'
    final: boolean
    text: string
    stash?: string
  }
  | { type: 'voice.playback-clear'; serverSeq: number; streamId: number; reason: 'barge-in' | 'cancelled' }
  | { type: 'voice.agent-status'; serverSeq: number; sessionId: string; running: boolean; summary?: string }
  | {
    type: 'voice.tool'
    serverSeq: number
    callId: string
    name: string
    status: 'started' | 'completed' | 'failed'
    message?: string
  }
  | { type: 'voice.pong'; serverSeq: number; sentAt: number }
  | { type: 'voice.error'; serverSeq: number; code: string; message: string; recoverable: boolean }
  | { type: 'voice.ended'; serverSeq: number; reason: string }

export const enum AudioFrameKind {
  ClientInput = 1,
  ServerOutput = 2,
}

export const enum AudioFrameCodec {
  PcmS16Le = 1,
}

export const enum AudioFrameFlags {
  None = 0,
  Discontinuity = 1 << 0,
  EndOfStream = 1 << 1,
}

export interface DecodedAudioFrame {
  kind: AudioFrameKind
  codec: AudioFrameCodec
  flags: number
  streamId: number
  sequence: number
  ptsMs: number
  payload: Uint8Array
}

/** Encode one ordered frame in network byte order for browsers and Mini Program ArrayBuffers. */
export function encodeAudioFrame(
  kind: AudioFrameKind,
  streamId: number,
  sequence: number,
  payload: ArrayBuffer | Uint8Array,
  metadata: { ptsMs?: number; flags?: number } = {},
): ArrayBuffer {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  const result = new ArrayBuffer(AUDIO_HEADER_BYTES + bytes.byteLength)
  const view = new DataView(result)
  AUDIO_MAGIC.forEach((byte, index) => view.setUint8(index, byte))
  view.setUint8(4, VOICE_PROTOCOL_VERSION)
  view.setUint8(5, kind)
  view.setUint8(6, AudioFrameCodec.PcmS16Le)
  view.setUint8(7, metadata.flags ?? AudioFrameFlags.None)
  view.setUint32(8, streamId)
  view.setUint32(12, sequence)
  view.setUint32(16, metadata.ptsMs ?? 0)
  view.setUint32(20, bytes.byteLength)
  new Uint8Array(result, AUDIO_HEADER_BYTES).set(bytes)
  return result
}

/** Decode and validate a binary voice frame without retaining the caller's mutable view. */
export function decodeAudioFrame(data: ArrayBuffer | Uint8Array): DecodedAudioFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength < AUDIO_HEADER_BYTES) throw new Error('voice audio frame is shorter than its header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (AUDIO_MAGIC.some((byte, index) => view.getUint8(index) !== byte)) {
    throw new Error('voice audio frame has an invalid magic')
  }
  if (view.getUint8(4) !== VOICE_PROTOCOL_VERSION) throw new Error('voice audio frame uses an unsupported version')
  const kind = view.getUint8(5)
  if (kind !== AudioFrameKind.ClientInput && kind !== AudioFrameKind.ServerOutput) {
    throw new Error('voice audio frame has an unknown kind')
  }
  const codec = view.getUint8(6)
  if (codec !== AudioFrameCodec.PcmS16Le) throw new Error('voice audio frame uses an unsupported codec')
  const flags = view.getUint8(7)
  if ((flags & ~(AudioFrameFlags.Discontinuity | AudioFrameFlags.EndOfStream)) !== 0) {
    throw new Error('voice audio frame uses unsupported flags')
  }
  const payloadLength = view.getUint32(20)
  if (payloadLength !== bytes.byteLength - AUDIO_HEADER_BYTES) {
    throw new Error('voice audio frame payload length does not match its header')
  }
  return {
    kind,
    codec,
    flags,
    streamId: view.getUint32(8),
    sequence: view.getUint32(12),
    ptsMs: view.getUint32(16),
    payload: bytes.slice(AUDIO_HEADER_BYTES),
  }
}

/** Narrow an untrusted JSON value to the client control messages accepted by the Host. */
export function isVoiceClientControl(value: unknown): value is VoiceClientControl {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const message = value as Record<string, unknown>
  if (message.type === 'voice.end') return message.reason === undefined || (typeof message.reason === 'string' && message.reason.length <= 128)
  if (message.type === 'voice.cancel-response' || message.type === 'voice.commit') return true
  if (message.type === 'voice.ping') return typeof message.sentAt === 'number' && Number.isFinite(message.sentAt)
  if (message.type !== 'voice.hello') return false
  const client = message.client as Record<string, unknown> | undefined
  const target = message.target as Record<string, unknown> | undefined
  const audio = message.audio as Record<string, unknown> | undefined
  return message.protocol === VOICE_PROTOCOL
    && typeof message.requestId === 'string'
    && message.requestId.length > 0
    && message.requestId.length <= 128
    && isClientPlatform(client?.platform)
    && typeof client.version === 'string'
    && client.version.length <= 64
    && client.binaryWebSocket === true
    && client.playbackClear === true
    && client.pcmS16leVerified === true
    && typeof client.foregroundOnly === 'boolean'
    && (client.duplex === 'full' || client.duplex === 'best-effort' || client.duplex === 'turn-based')
    && typeof target?.sessionId === 'string'
    && target.sessionId.length > 0
    && target.sessionId.length <= 256
    && isPcmSpec(audio?.input)
    && isPcmSpec(audio?.output)
}

function isClientPlatform(value: unknown): value is VoiceClientPlatform {
  return value === 'web'
    || value === 'wechat-mini-program'
    || value === 'ios'
    || value === 'android'
    || value === 'unknown'
}

function isPcmSpec(value: unknown): value is PcmAudioSpec {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as Record<string, unknown>
  return spec.encoding === 'pcm_s16le'
    && typeof spec.sampleRate === 'number'
    && Number.isInteger(spec.sampleRate)
    && spec.sampleRate > 0
    && spec.channels === AUDIO_CHANNELS
    && typeof spec.frameDurationMs === 'number'
    && Number.isFinite(spec.frameDurationMs)
    && spec.frameDurationMs > 0
    && spec.frameDurationMs <= 1000
}
