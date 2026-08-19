/** DSH browser half: official slot registrations backed by one root-lifetime call controller. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  REALTIME_VOICE_SETTINGS_NAMESPACE,
  type RealtimeVoiceModel,
  type RealtimeVoiceTurnDetection,
} from '../models.ts'
import { VoiceCallController } from './controller.ts'
import { decodeVoiceModelSettings, VoiceModelSettingsController } from './model-settings.ts'
import type { VoiceButtonInjected } from './VoiceButton.tsx'
import { VoiceButton } from './VoiceButton.tsx'
import type { VoiceOverlayInjected } from './VoiceOverlay.tsx'
import { VoiceOverlay } from './VoiceOverlay.tsx'
import type { VoiceSettingsCardInjected } from './VoiceSettingsCard.tsx'
import { VoiceSettingsCard } from './VoiceSettingsCard.tsx'

export const inject = ['slots', 'sessions', 'connection', 'remote', 'settingsScope']

/** Register one composer action and one frame overlay; both disappear with this client fiber. */
export function apply(ctx: ClientContext): void {
  const voice = new VoiceCallController()
  const { api } = ctx.get('connection') as ConnectionHandle
  const modelSettings = new VoiceModelSettingsController(ctx.settingsScope.bind({
    namespace: REALTIME_VOICE_SETTINGS_NAMESPACE,
    decode: decodeVoiceModelSettings,
  }), api)
  ctx.effect(() => async () => {
    modelSettings.dispose()
    await voice.dispose()
  }, 'realtime-voice: browser media and settings lifecycle')
  ctx.effect(
    () => ctx.remote.$on('credentials/updated', ref => { modelSettings.refreshCredential(ref) }),
    'realtime-voice: credential state invalidation',
  )

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'realtime-voice',
    order: 20,
    inject: (sessionId): VoiceButtonInjected => ({
      hooks: { voice },
      toggle: () => {
        const phase = voice.getSnapshot().phase
        if (phase === 'idle' || phase === 'error') void voice.start(sessionId)
        else void voice.end()
      },
    }),
  }, VoiceButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'realtime-voice',
    order: 100,
    inject: (): VoiceOverlayInjected => ({
      hooks: { voice },
      end: () => voice.end(),
      toggleMute: () => voice.toggleMute(),
      cancelResponse: () => voice.cancelResponse(),
      openSession: (sessionId) => {
        ctx.sessions.open(sessionId as Parameters<typeof ctx.sessions.open>[0])
      },
    }),
  }, VoiceOverlay))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: REALTIME_VOICE_SETTINGS_NAMESPACE,
    priority: 30,
    inject: (): VoiceSettingsCardInjected => ({
      hooks: { voiceModelSettings: modelSettings },
      selectModel: (model: RealtimeVoiceModel) => { void modelSettings.select(model) },
      selectTurnDetection: (mode: RealtimeVoiceTurnDetection) => { void modelSettings.selectTurnDetection(mode) },
      saveApiKey: (value: string) => modelSettings.saveApiKey(value),
    }),
  }, VoiceSettingsCard))
}
