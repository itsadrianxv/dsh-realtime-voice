import { describe, expect, it, vi } from 'vitest'
import { VoiceRuntime } from '../src/host/voice-runtime.ts'

describe('VoiceRuntime authoritative occupancy', () => {
  it('allows exactly one client and exposes its platform to other surfaces', () => {
    const runtime = new VoiceRuntime()
    const web = runtime.acquireLease({
      connectionId: 'web-1',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      revoke: vi.fn(),
    })
    expect(web.ok).toBe(true)

    const mini = runtime.acquireLease({
      connectionId: 'mini-1',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      revoke: vi.fn(),
    })
    expect(mini).toMatchObject({
      ok: false,
      occupancy: { active: true, owner: { platform: 'web', sessionId: 'session-1' } },
    })
  })

  it('atomically replaces a stale transport only when it resumes the same voice call', () => {
    const runtime = new VoiceRuntime()
    const revokeOld = vi.fn()
    const initial = runtime.acquireLease({
      connectionId: 'mini-old',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      revoke: revokeOld,
    })
    if (!initial.ok) throw new Error('initial lease was not acquired')

    const resumed = runtime.acquireLease({
      connectionId: 'mini-new',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      resumeId: initial.state.id,
      revoke: vi.fn(),
    })
    expect(resumed).toMatchObject({ ok: true, resumed: true })
    expect(revokeOld).toHaveBeenCalledTimes(1)

    // A delayed close from the replaced socket must not release the new owner.
    runtime.release('mini-old')
    expect(runtime.occupancy()).toMatchObject({ active: true, owner: { voiceSessionId: initial.state.id } })
    runtime.release('mini-new')
    expect(runtime.occupancy()).toEqual({ protocol: 'dsh.voice.v1', active: false })
  })
})
