import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { VoiceConfig } from '../src/host/config.ts'
import { VOICE_ROUTE } from '../src/protocol.ts'

const config: VoiceConfig = {
  endpoint: 'wss://example.invalid/realtime',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  model: 'qwen-audio-3.0-realtime-plus',
  voice: 'longanqian',
  turnDetection: 'smart_turn',
  vadThreshold: 0.35,
  silenceDurationMs: 600,
  maxHistoryTurns: 20,
  maxConnections: 4,
  maxBinaryFrameBytes: 64 * 1024,
  connectTimeoutMs: 15_000,
}

describe('Host plugin lifecycle', () => {
  it('registers exactly one official upgrade route and unregisters it on dispose', async () => {
    const unregister = vi.fn()
    const registerUpgrade = vi.fn(() => unregister)
    let lifecycle: (() => void | Promise<void>) | undefined
    const context = {
      webServer: { registerUpgrade },
      effect: vi.fn((factory: () => () => void | Promise<void>) => {
        lifecycle = factory()
      }),
      // Settings is an optional Host service; this lifecycle unit deliberately
      // exercises the no-settings composition.
      inject: vi.fn(),
    }

    apply(context as never, config)
    expect(registerUpgrade).toHaveBeenCalledTimes(1)
    expect(registerUpgrade.mock.calls[0]?.[0]).toMatchObject({ path: VOICE_ROUTE })
    expect(lifecycle).toBeTypeOf('function')

    await lifecycle?.()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
