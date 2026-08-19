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
      {active ? <span className={styles.stopGlyph} /> : <VoiceGlyph />}
    </button>
  )
}

function VoiceGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
      <path d="M12 3.25a3 3 0 0 0-3 3v5.5a3 3 0 0 0 6 0v-5.5a3 3 0 0 0-3-3Z" />
      <path d="M6.75 10.75v1a5.25 5.25 0 0 0 10.5 0v-1M12 17v3.25M9.25 20.25h5.5" />
    </svg>
  )
}
