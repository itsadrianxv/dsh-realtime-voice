import { describe, expect, it } from 'vitest'
import {
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
})
