import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceCallController } from '../src/client/controller.ts'

describe('browser voice start arbitration', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('claims the local start slot before the asynchronous occupancy preflight', async () => {
    let resolveFetch!: (value: unknown) => void
    const fetchPromise = new Promise(resolve => { resolveFetch = resolve })
    const fetch = vi.fn(() => fetchPromise)
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('fetch', fetch)

    const controller = new VoiceCallController()
    const first = controller.start('session-one')
    const duplicate = controller.start('session-one')

    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', sessionId: 'session-one' })
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveFetch({
      ok: true,
      json: async () => ({ protocol: 'dsh.voice.v1', active: true }),
    })
    await Promise.all([first, duplicate])
    expect(controller.getSnapshot().phase).toBe('error')
    await controller.dispose()
  })
})
