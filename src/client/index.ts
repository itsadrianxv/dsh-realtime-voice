/** DSH browser half: official slot registrations backed by one root-lifetime call controller. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { VoiceCallController } from './controller.ts'
import type { VoiceButtonInjected } from './VoiceButton.tsx'
import { VoiceButton } from './VoiceButton.tsx'
import type { VoiceOverlayInjected } from './VoiceOverlay.tsx'
import { VoiceOverlay } from './VoiceOverlay.tsx'

export const inject = ['slots', 'sessions']

/** Register one composer action and one frame overlay; both disappear with this client fiber. */
export function apply(ctx: ClientContext): void {
  const voice = new VoiceCallController()
  ctx.effect(() => async () => voice.dispose(), 'realtime-voice: browser media lifecycle')

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
}
