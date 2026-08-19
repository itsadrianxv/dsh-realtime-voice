import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceSnapshot } from './controller.ts'
import styles from './voice.module.css'

export interface VoiceButtonInjected {
  hooks: { voice: HostObservable<VoiceSnapshot> }
  toggle: () => void
}
export type VoiceButtonProps = PropsRuntime<'conversation.input.right'> & InjectFace<VoiceButtonInjected>

/** Compact call control in the official composer right-hand action slot. */
export function VoiceButton({ useVoice, toggle }: VoiceButtonProps) {
  const phase = useVoice(snapshot => snapshot.phase)
  const active = phase !== 'idle' && phase !== 'error'
  return (
    <button
      type="button"
      className={`${styles.callButton} ${active ? styles.callButtonActive : ''}`}
      aria-label={active ? '结束实时语音' : '开始实时语音'}
      title={active ? '结束实时语音' : '实时语音'}
      onClick={toggle}
    >
      {active ? <span className={styles.stopGlyph} /> : <CallGlyph />}
    </button>
  )
}

function CallGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
      <path fill="currentColor" stroke="none" d="M7.2 3.75 9.6 7.7 7.95 9.3c1.2 2.55 3.2 4.55 5.75 5.75l1.6-1.65 3.95 2.4-.55 3.4c-.14.85-.9 1.45-1.76 1.39C9.8 20.08 3.92 14.2 3.41 7.06A1.68 1.68 0 0 1 4.8 5.3l2.4-1.55Z" />
      <path fill="none" d="M14.2 5.8c1.85.46 3.54 2.15 4 4M14.55 2.5c3.45.58 6.37 3.5 6.95 6.95" />
    </svg>
  )
}
