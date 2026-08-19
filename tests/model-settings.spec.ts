import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { Config } from '../src/host/config.ts'
import { REALTIME_VOICE_MODELS, REALTIME_VOICE_TURN_DETECTION } from '../src/models.ts'
import {
  decodeVoiceModelSettings,
  VoiceModelSettingsController,
  type VoiceModelSettingsValue,
} from '../src/client/model-settings.ts'

describe('realtime voice model settings', () => {
  it('admits only the two provider-compatible realtime models', () => {
    expect(new Config({}).model).toBe(REALTIME_VOICE_MODELS.plus)
    expect(new Config({}).turnDetection).toBe(REALTIME_VOICE_TURN_DETECTION.fast)
    expect(new Config({}).vadThreshold).toBe(0.35)
    expect(new Config({ model: REALTIME_VOICE_MODELS.flash }).model).toBe(REALTIME_VOICE_MODELS.flash)
    expect(() => new Config({ model: 'unrelated-model' as never })).toThrow()
  })

  it('persists an immediate switch and projects the accepted model', async () => {
    let snapshot = ready(REALTIME_VOICE_MODELS.plus)
    const listeners = new Set<() => void>()
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: vi.fn(async (field: string, value: unknown) => {
        const current = snapshot.value!
        snapshot = ready(
          field === 'model' ? value as VoiceModelSettingsValue['model'] : current.model,
          field === 'turnDetection' ? value as VoiceModelSettingsValue['turnDetection'] : current.turnDetection,
        )
        for (const listener of listeners) listener()
      }),
      unset: vi.fn(),
    } as unknown as SettingsScope<VoiceModelSettingsValue>
    const credentials = {
      describe: vi.fn(async () => ({
        rpcId: 'test',
        result: { ok: true as const, value: { credentials: { DASHSCOPE_API_KEY: { configured: true, writable: true } } } },
      })),
      set: vi.fn(async () => ({ rpcId: 'test', result: { ok: true as const, value: {} } })),
      unset: vi.fn(),
    }
    const controller = new VoiceModelSettingsController(scope, { credentials } as never)

    await controller.select(REALTIME_VOICE_MODELS.flash)

    expect(scope.set).toHaveBeenCalledWith('model', REALTIME_VOICE_MODELS.flash)
    expect(controller.getSnapshot()).toMatchObject({
      available: true,
      model: REALTIME_VOICE_MODELS.flash,
      saving: false,
    })

    await controller.selectTurnDetection(REALTIME_VOICE_TURN_DETECTION.semantic)
    expect(scope.set).toHaveBeenCalledWith('turnDetection', REALTIME_VOICE_TURN_DETECTION.semantic)
    expect(controller.getSnapshot().turnDetection).toBe(REALTIME_VOICE_TURN_DETECTION.semantic)
    controller.dispose()
  })

  it('detects an existing environment/credential key and can replace it write-only', async () => {
    let snapshot = ready(REALTIME_VOICE_MODELS.flash)
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: vi.fn(),
      unset: vi.fn(),
    } as unknown as SettingsScope<VoiceModelSettingsValue>
    const describe = vi.fn(async () => ({
      rpcId: 'test',
      result: { ok: true as const, value: { credentials: { DASHSCOPE_API_KEY: { configured: true, writable: true } } } },
    }))
    const set = vi.fn(async () => ({ rpcId: 'test', result: { ok: true as const, value: {} } }))
    const controller = new VoiceModelSettingsController(scope, { credentials: { describe, set } } as never)
    await vi.waitFor(() => { expect(controller.getSnapshot().apiKeyConfigured).toBe(true) })

    await expect(controller.saveApiKey(' new-secret ')).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith({ ref: 'DASHSCOPE_API_KEY', value: 'new-secret' })
    // The literal is never projected back into browser state.
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('new-secret')
    controller.dispose()
  })

  it('rejects malformed browser settings snapshots', () => {
    expect(decodeVoiceModelSettings({ model: REALTIME_VOICE_MODELS.flash })).toEqual({
      model: REALTIME_VOICE_MODELS.flash,
      turnDetection: REALTIME_VOICE_TURN_DETECTION.fast,
    })
    expect(decodeVoiceModelSettings({
      model: REALTIME_VOICE_MODELS.flash,
      turnDetection: REALTIME_VOICE_TURN_DETECTION.semantic,
    })).toEqual({
      model: REALTIME_VOICE_MODELS.flash,
      turnDetection: REALTIME_VOICE_TURN_DETECTION.semantic,
    })
    expect(decodeVoiceModelSettings({
      model: REALTIME_VOICE_MODELS.flash,
      turnDetection: 'unknown',
    })).toBeUndefined()
    expect(decodeVoiceModelSettings({ model: 'other' })).toBeUndefined()
    expect(decodeVoiceModelSettings(null)).toBeUndefined()
  })
})

function ready(
  model: VoiceModelSettingsValue['model'],
  turnDetection: VoiceModelSettingsValue['turnDetection'] = REALTIME_VOICE_TURN_DETECTION.fast,
): SettingsScopeSnapshot<VoiceModelSettingsValue> {
  return {
    status: 'ready',
    value: { model, turnDetection },
    base: { model: REALTIME_VOICE_MODELS.plus, turnDetection: REALTIME_VOICE_TURN_DETECTION.fast },
    user: { model, turnDetection },
    revision: 1,
    writable: true,
    mode: 'host',
  }
}
