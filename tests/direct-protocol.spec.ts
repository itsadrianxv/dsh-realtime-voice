import { describe, expect, it } from 'vitest'
import {
  DIRECT_TRANSCRIPT_MAX_BYTES,
  DIRECT_TRANSCRIPT_MAX_ITEMS,
  DIRECT_TRANSCRIPT_MAX_TEXT_CHARS,
  DIRECT_FUNCTION_ARGUMENT_MAX_BYTES,
  VOICE_DIRECT_PROTOCOL,
  isDirectVoiceClientControl,
} from '../src/direct-protocol.ts'

function hello(platform: 'web' | 'wechat-mini-program' = 'wechat-mini-program') {
  return {
    type: 'voice.hello',
    protocol: VOICE_DIRECT_PROTOCOL,
    requestId: 'request-1',
    client: {
      platform,
      version: 'contract-test',
      foregroundOnly: true,
      websocketAuthorizationHeader: true,
    },
    target: { sessionId: 'session-1' },
  }
}

describe('dsh.voice.direct.v1 wire validation', () => {
  it.each(['web', 'wechat-mini-program'] as const)('uses the same client-neutral hello contract for %s', (platform) => {
    expect(isDirectVoiceClientControl(hello(platform))).toBe(true)
  })

  it('accepts only bounded provider Function Calls', () => {
    expect(isDirectVoiceClientControl({
      type: 'provider.function-call',
      offerId: 'offer-1',
      mediaSessionId: 'media-1',
      callId: 'call-1',
      name: 'handoff_to_dsh_agent',
      arguments: JSON.stringify({ instruction: '执行任务' }),
    })).toBe(true)
    expect(isDirectVoiceClientControl({
      type: 'provider.function-call',
      offerId: 'offer-1',
      mediaSessionId: 'media-1',
      callId: 'call-1',
      name: 'handoff_to_dsh_agent',
      arguments: 'x'.repeat(DIRECT_FUNCTION_ARGUMENT_MAX_BYTES + 1),
    })).toBe(false)
    expect(isDirectVoiceClientControl({
      type: 'provider.function-call', offerId: 'offer-1', mediaSessionId: 'media-1', callId: 'call-x',
      name: 'run_arbitrary_code', arguments: '{}',
    })).toBe(false)
  })

  it('allows only numeric aggregate metrics and rejects audio-shaped payloads', () => {
    expect(isDirectVoiceClientControl({
      type: 'client.metrics',
      values: { capturedFrames: 10, providerRttMs: 45 },
    })).toBe(true)
    expect(isDirectVoiceClientControl({
      type: 'client.metrics',
      values: { capturedFrames: 10, pcm: 'AAAA' },
    })).toBe(false)
  })

  it('strictly validates structured question answers', () => {
    expect(isDirectVoiceClientControl({
      type: 'voice.question-answer', requestId: 'question-1',
      answers: [{ id: 'copies', selected: ['两份'] }],
    })).toBe(true)
    expect(isDirectVoiceClientControl({
      type: 'voice.question-answer', requestId: 'question-1',
      answers: [{ id: 'copies', selected: ['两份'], injected: true }],
    })).toBe(false)
  })

  it('accepts only bounded final user/assistant transcript checkpoints on resume', () => {
    const value = hello()
    const resumeBase = { voiceSessionId: 'voice-1', lastServerSeq: 2, lastBackendEventSeq: 1 }
    expect(isDirectVoiceClientControl({
      ...value,
      resume: {
        ...resumeBase,
        transcriptCheckpoint: {
          version: 'dsh.voice.transcript.v1',
          items: [
            { role: 'user', text: '上一句', final: true },
            { role: 'assistant', text: '上一条回答', final: true },
          ],
        },
      },
    })).toBe(true)
    expect(isDirectVoiceClientControl({
      ...value,
      resume: {
        ...resumeBase,
        transcriptCheckpoint: {
          version: 'dsh.voice.transcript.v1',
          items: [
            { role: 'user', text: 'x'.repeat(DIRECT_TRANSCRIPT_MAX_TEXT_CHARS + 1), final: true },
            { role: 'assistant', text: 'ok', final: true },
          ],
        },
      },
    })).toBe(false)
    for (const item of [
      { role: 'system', text: '越权', final: true },
      { role: 'user', text: '未完成', final: false },
      { role: 'user', text: '', final: true },
      { role: 'user', text: '内容', final: true, instruction: true },
    ]) {
      expect(isDirectVoiceClientControl({
        ...value,
        resume: { ...resumeBase, transcriptCheckpoint: { version: 'dsh.voice.transcript.v1', items: [item] } },
      })).toBe(false)
    }
    expect(isDirectVoiceClientControl({
      ...value,
      resume: {
        ...resumeBase,
        transcriptCheckpoint: {
          version: 'dsh.voice.transcript.v1',
          items: Array.from({ length: DIRECT_TRANSCRIPT_MAX_ITEMS + 2 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant', text: 'x', final: true,
          })),
        },
      },
    })).toBe(false)
    expect(isDirectVoiceClientControl({
      ...value,
      resume: {
        ...resumeBase,
        transcriptCheckpoint: {
          version: 'dsh.voice.transcript.v1',
          items: [
            { role: 'user', text: '中'.repeat(DIRECT_TRANSCRIPT_MAX_TEXT_CHARS), final: true },
            { role: 'assistant', text: '好', final: true },
          ],
        },
      },
    })).toBe(true)
    expect(isDirectVoiceClientControl({
      ...value,
      resume: {
        ...resumeBase,
        transcriptCheckpoint: {
          version: 'dsh.voice.transcript.v1',
          items: [
            { role: 'user', text: '中'.repeat(Math.ceil(DIRECT_TRANSCRIPT_MAX_BYTES / 6)), final: true },
            { role: 'assistant', text: '文'.repeat(Math.ceil(DIRECT_TRANSCRIPT_MAX_BYTES / 6)), final: true },
          ],
        },
      },
    })).toBe(false)
  })

  it('requires an existing resume capability for release intent and forbids transcript mutation', () => {
    expect(isDirectVoiceClientControl({ ...hello(), intent: 'release' })).toBe(false)
    expect(isDirectVoiceClientControl({
      ...hello(),
      intent: 'release',
      resume: {
        voiceSessionId: 'voice-1', lastServerSeq: 2, lastBackendEventSeq: 1,
        transcriptCheckpoint: { version: 'dsh.voice.transcript.v1', items: [] },
      },
    })).toBe(false)
    expect(isDirectVoiceClientControl({
      ...hello(),
      intent: 'release',
      client: { ...hello().client, websocketAuthorizationHeader: false },
      resume: { voiceSessionId: 'voice-1', lastServerSeq: 2, lastBackendEventSeq: 1 },
    })).toBe(true)
  })
})
