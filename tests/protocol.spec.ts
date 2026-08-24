import { describe, expect, it } from 'vitest'
import { AudioFrameKind, decodeAudioFrame, encodeAudioFrame, isVoiceClientControl, VOICE_PROTOCOL } from '../src/protocol.ts'

describe('voice wire protocol', () => {
  it('round-trips binary audio metadata and payload', () => {
    const encoded = encodeAudioFrame(AudioFrameKind.ClientInput, 7, 42, new Uint8Array([1, 2, 3]))
    const decoded = decodeAudioFrame(encoded)
    expect(decoded.kind).toBe(AudioFrameKind.ClientInput)
    expect(decoded.streamId).toBe(7)
    expect(decoded.sequence).toBe(42)
    expect([...decoded.payload]).toEqual([1, 2, 3])
  })

  it('accepts the shared WebUI/Mini Program hello contract', () => {
    expect(isVoiceClientControl({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: 'request-1',
      client: {
        platform: 'wechat-mini-program',
        version: '1.0.0',
        binaryWebSocket: true,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: true,
        duplex: 'best-effort',
        playbackDrainAck: true,
        echoControl: 'client-filtered-preroll',
      },
      target: { sessionId: 'session-1' },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameDurationMs: 40 },
        output: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1, frameDurationMs: 40 },
      },
    })).toBe(true)
  })

  it('rejects a hello that cannot carry binary streaming audio', () => {
    expect(isVoiceClientControl({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: 'request-1',
      client: {
        platform: 'web',
        version: '1',
        binaryWebSocket: false,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: false,
        duplex: 'full',
      },
      target: { sessionId: 'session-1' },
      audio: {},
    })).toBe(false)
  })

  it('rejects an unknown client echo-control capability', () => {
    expect(isVoiceClientControl({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: 'request-1',
      client: {
        platform: 'unknown',
        version: '1',
        binaryWebSocket: true,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: false,
        duplex: 'best-effort',
        echoControl: 'platform-guessed',
      },
      target: { sessionId: 'session-1' },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameDurationMs: 32 },
        output: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1, frameDurationMs: 40 },
      },
    })).toBe(false)
  })

  it('rejects a binary frame whose declared payload length is corrupted', () => {
    const encoded = encodeAudioFrame(AudioFrameKind.ServerOutput, 2, 3, new Uint8Array([1, 2]))
    new DataView(encoded).setUint32(20, 99)
    expect(() => decodeAudioFrame(encoded)).toThrow(/payload length/)
  })

  it('rejects unknown binary flags and malformed control fields', () => {
    const encoded = encodeAudioFrame(AudioFrameKind.ClientInput, 1, 1, new Uint8Array([0, 0]))
    new DataView(encoded).setUint8(7, 0x80)
    expect(() => decodeAudioFrame(encoded)).toThrow(/flags/)
    expect(isVoiceClientControl({ type: 'voice.ping', sentAt: Number.NaN })).toBe(false)
    expect(isVoiceClientControl({ type: 'voice.end', reason: { nope: true } })).toBe(false)
    expect(isVoiceClientControl({ type: 'voice.playback-drained', streamId: 7 })).toBe(true)
    expect(isVoiceClientControl({ type: 'voice.playback-drained', streamId: -1 })).toBe(false)
  })

  it('accepts approval and structured-question answers but rejects malformed payloads', () => {
    expect(isVoiceClientControl({
      type: 'voice.approval-answer',
      approvalId: 'approval-1',
      outcome: 'allowed-once',
    })).toBe(true)
    expect(isVoiceClientControl({
      type: 'voice.question-answer',
      requestId: 'rpc-question',
      answers: [{ id: 'copies', selected: ['两份'], custom: '彩打' }],
    })).toBe(true)
    expect(isVoiceClientControl({
      type: 'voice.question-answer',
      requestId: 'rpc-question',
      answers: [],
    })).toBe(false)
  })
})
