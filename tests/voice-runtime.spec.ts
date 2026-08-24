import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/host/config.ts'
import { VoiceConnection } from '../src/host/voice-connection.ts'
import { VoiceRuntime } from '../src/host/voice-runtime.ts'

class FakeVoiceSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = this.OPEN

  send(): void {}
  close(): void { this.readyState = 3 }
}

describe('VoiceRuntime authoritative occupancy', () => {
  it('releases a pre-ready transport immediately because no client owns its resume token yet', () => {
    const runtime = new VoiceRuntime()
    const socket = new FakeVoiceSocket()
    const connection = new VoiceConnection(
      { logger: { warn: vi.fn() } } as never,
      socket as never,
      {} as never,
      new Config({}),
      vi.fn(),
      runtime,
    )
    const lease = runtime.acquireLease({
      connectionId: connection.id,
      platform: 'web',
      clientVersion: 'test',
      sessionId: 'session-one',
      revoke: vi.fn(),
    })
    if (!lease.ok) throw new Error('pre-ready lease was not acquired')
    const internal = connection as unknown as { leaseAcquired: boolean }
    internal.leaseAcquired = true

    connection.dispose('client-disconnected')

    expect(runtime.occupancy()).toEqual({ protocol: 'dsh.voice.v1', active: false })
    expect(runtime.acquireLease({
      connectionId: 'cannot-resume-ghost',
      platform: 'web',
      clientVersion: 'test',
      sessionId: 'session-one',
      resumeId: lease.state.id,
      revoke: vi.fn(),
    })).toMatchObject({ ok: false, reason: 'invalid-resume' })
  })

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
    expect(runtime.occupancy().owner).not.toHaveProperty('voiceSessionId')
  })

  it('atomically replaces only a disconnected transport that resumes the same voice call', () => {
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
    runtime.release('mini-old', true)

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
    expect(runtime.occupancy()).toMatchObject({ active: true, owner: { platform: 'wechat-mini-program' } })
    runtime.release('mini-new')
    expect(runtime.occupancy()).toEqual({ protocol: 'dsh.voice.v1', active: false })
  })

  it('does not let a duplicate resume token kick a healthy owner transport', () => {
    const runtime = new VoiceRuntime()
    const revokeOld = vi.fn()
    const initial = runtime.acquireLease({
      connectionId: 'mini-healthy',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      revoke: revokeOld,
    })
    if (!initial.ok) throw new Error('initial lease was not acquired')

    const duplicate = runtime.acquireLease({
      connectionId: 'mini-duplicate',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      resumeId: initial.state.id,
      revoke: vi.fn(),
    })
    expect(duplicate).toMatchObject({ ok: false, occupancy: { active: true } })
    expect(revokeOld).not.toHaveBeenCalled()
  })

  it('holds a disconnected lease for grace, then permits a fresh caller without leaking its token', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00Z'))
    try {
      const runtime = new VoiceRuntime(10 * 60_000, 30_000, 45_000)
      const initial = runtime.acquireLease({
        connectionId: 'mini-old',
        platform: 'wechat-mini-program',
        clientVersion: '1.1.0-research',
        sessionId: 'session-1',
        revoke: vi.fn(),
      })
      if (!initial.ok) throw new Error('initial lease was not acquired')
      runtime.release('mini-old', true)
      expect(runtime.occupancy()).toMatchObject({ active: true })
      expect(runtime.occupancy().owner).not.toHaveProperty('voiceSessionId')

      vi.advanceTimersByTime(30_001)
      expect(runtime.occupancy()).toEqual({ protocol: 'dsh.voice.v1', active: false })
      expect(runtime.acquireLease({
        connectionId: 'web-new',
        platform: 'web',
        clientVersion: '0.1.0',
        sessionId: 'session-2',
        revoke: vi.fn(),
      })).toMatchObject({ ok: true, resumed: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let another platform hijack a lease with public occupancy metadata', () => {
    const runtime = new VoiceRuntime()
    const initial = runtime.acquireLease({
      connectionId: 'mini-old',
      platform: 'wechat-mini-program',
      clientVersion: '1.1.0-research',
      sessionId: 'session-1',
      revoke: vi.fn(),
    })
    if (!initial.ok) throw new Error('initial lease was not acquired')

    const web = runtime.acquireLease({
      connectionId: 'web-new',
      platform: 'web',
      clientVersion: '0.1.0-alpha.9-research.3',
      sessionId: 'session-1',
      resumeId: initial.state.id,
      revoke: vi.fn(),
    })
    expect(web).toMatchObject({ ok: false, occupancy: { active: true, owner: { platform: 'wechat-mini-program' } } })
  })

  it('rejects resume across sessions and preserves sequence cursors on a valid reconnect', () => {
    const runtime = new VoiceRuntime()
    const initial = runtime.acquireLease({
      connectionId: 'client-old',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      revoke: vi.fn(),
    })
    if (!initial.ok) throw new Error('initial lease was not acquired')
    initial.state.serverSeq = 41
    initial.state.outputStreamId = 5
    initial.state.outputSequence = 17
    runtime.release('client-old', true)

    expect(runtime.acquireLease({
      connectionId: 'wrong-session',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-2',
      resumeId: initial.state.id,
      revoke: vi.fn(),
    })).toMatchObject({ ok: false, reason: 'busy' })

    const resumed = runtime.acquireLease({
      connectionId: 'client-new',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      resumeId: initial.state.id,
      revoke: vi.fn(),
    })
    expect(resumed).toMatchObject({
      ok: true,
      resumed: true,
      state: { serverSeq: 41, outputStreamId: 5, outputSequence: 17 },
    })
  })

  it('rejects an expired or unknown resume token instead of silently starting a new call', () => {
    const runtime = new VoiceRuntime()
    expect(runtime.acquireLease({
      connectionId: 'unknown-resume',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      resumeId: 'not-a-real-token',
      revoke: vi.fn(),
    })).toMatchObject({ ok: false, reason: 'invalid-resume', occupancy: { active: false } })

    const ended = runtime.acquireLease({
      connectionId: 'ended-owner',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      revoke: vi.fn(),
    })
    if (!ended.ok) throw new Error('ended lease was not acquired')
    runtime.release('ended-owner')
    expect(runtime.acquireLease({
      connectionId: 'resume-ended-call',
      platform: 'web',
      clientVersion: '0.1.0',
      sessionId: 'session-1',
      resumeId: ended.state.id,
      revoke: vi.fn(),
    })).toMatchObject({ ok: false, reason: 'invalid-resume', occupancy: { active: false } })
  })
})
