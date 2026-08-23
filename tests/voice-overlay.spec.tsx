import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VoiceOverlay } from '../src/client/VoiceOverlay.tsx'
import type { VoiceSnapshot } from '../src/client/controller.ts'

describe('floating voice overlay', () => {
  it('renders the bound session, fast VAD mode, and independent call controls', () => {
    const voice: VoiceSnapshot = {
      phase: 'speaking',
      sessionId: 'session-one',
      voiceSessionId: 'voice-one',
      muted: false,
      userTranscript: '请继续',
      assistantTranscript: '正在处理。',
      agentRunning: false,
      providerModel: 'qwen-audio-3.0-realtime-plus',
      turnDetection: 'server_vad',
      elapsedSeconds: 65,
      pendingApproval: { approvalId: 'approval-one', toolName: 'exec_command', reason: '需要访问打印机' },
    }
    const html = renderToStaticMarkup(<VoiceOverlay {...({
      useVoice: (selector: (value: VoiceSnapshot) => unknown) => selector(voice),
      useSessions: (selector: (value: unknown) => unknown) => selector({
        current: 'session-one',
        byId: { 'session-one': { displayTitle: '绑定任务', blank: false } },
      }),
      end: vi.fn(),
      toggleMute: vi.fn(),
      cancelResponse: vi.fn(),
      openSession: vi.fn(),
    } as never)} />)

    expect(html).toContain('aria-label="实时语音通话"')
    expect(html).toContain('绑定任务')
    expect(html).toContain('快速声学打断')
    expect(html).toContain('立即打断')
    expect(html).toContain('需要你的批准')
    expect(html).toContain('仅允许这一次')
    expect(html).toContain('01:05')
  })
})
