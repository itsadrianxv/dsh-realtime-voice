import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { useState } from 'react'
import { realtimeVoiceModelLabel } from '../models.ts'
import type { VoiceSnapshot } from './controller.ts'
import styles from './voice.module.css'

export interface VoiceOverlayInjected {
  hooks: { voice: HostObservable<VoiceSnapshot> }
  end: () => void
  toggleMute: () => void
  cancelResponse: () => void
  openSession: (sessionId: string) => void
}
export type VoiceOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<VoiceOverlayInjected>

/** Frame-wide call surface that remains visible while the user changes DSH sessions. */
export function VoiceOverlay({ useVoice, useSessions, end, toggleMute, cancelResponse, openSession }: VoiceOverlayProps) {
  const voice = useVoice(snapshot => snapshot)
  const [collapsed, setCollapsed] = useState(false)
  const boundSession = useSessions(state => voice.sessionId === undefined
    ? undefined
    : state.byId[voice.sessionId as SessionId])
  const currentSessionId = useSessions(state => state.current)
  const viewingOtherSession = voice.sessionId !== undefined && currentSessionId !== voice.sessionId
  if (voice.phase === 'idle') return null
  if (voice.phase === 'error') {
    return (
      <section className={`${styles.overlay} ${styles.overlayError}`} role="alert">
        <div className={styles.errorText}>{voice.error}</div>
        <button type="button" className={styles.secondaryButton} onClick={() => void end()}>关闭</button>
      </section>
    )
  }
  return (
    <section className={`${styles.overlay} ${collapsed ? styles.overlayCollapsed : ''}`} aria-label="实时语音通话">
      <header className={styles.overlayHeader}>
        <div>
          <div className={styles.eyebrow}>DSH 实时语音</div>
          <div className={styles.phaseLine}>
            <span className={styles.liveDot} />
            {phaseText(voice.phase)} · {formatElapsed(voice.elapsedSeconds)}
          </div>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.agentState}>{voice.agentRunning ? 'Agent 工作中' : 'Agent 待命'}</div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={collapsed ? '展开通话面板' : '收起通话面板'}
            title={collapsed ? '展开' : '收起'}
            onClick={() => setCollapsed(value => !value)}
          >{collapsed ? '‹' : '›'}</button>
        </div>
      </header>
      {collapsed ? null : (
        <>
          <div className={styles.bindingCard}>
            <div className={styles.bindingLabel}>本次通话一对一绑定</div>
            <div className={styles.bindingTitle}>{boundSession?.displayTitle ?? '当前 DSH 会话'}</div>
            <div className={styles.bindingMeta}>
              {boundSession?.blank === true ? '空白新会话 · 首个 Agent 指令会写入第一轮' : '工作指令与 Agent 结果保存在此线程'}
              {' · '}{realtimeVoiceModelLabel(voice.providerModel)}
            </div>
            {viewingOtherSession ? (
              <button type="button" className={styles.returnLink} onClick={() => openSession(voice.sessionId!)}>
                当前正在查看其他线程，返回绑定线程
              </button>
            ) : null}
          </div>
          <div className={styles.transcripts}>
            <div className={styles.transcriptBlock}>
              <span className={styles.speakerLabel}>你</span>
              <p className={styles.userText}>{voice.userTranscript || '正在聆听…'}</p>
            </div>
            <div className={styles.transcriptBlock}>
              <span className={styles.speakerLabel}>语音 Agent</span>
              <p className={styles.assistantText}>{voice.assistantTranscript || '你可以直接交代任务、追问进度或随时纠正方向。'}</p>
            </div>
          </div>
          {voice.agentSummary === undefined ? null : (
            <div className={styles.agentSummary}><strong>DSH Agent 最新结果</strong>{voice.agentSummary}</div>
          )}
          {voice.error === undefined ? null : <div className={styles.inlineError}>{voice.error}</div>}
          <footer className={styles.controls}>
            <button type="button" className={styles.secondaryButton} onClick={toggleMute}>
              {voice.muted ? '取消静音' : '静音'}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={cancelResponse}>打断播报</button>
            {voice.sessionId === undefined || !viewingOtherSession ? null : (
              <button type="button" className={styles.secondaryButton} onClick={() => openSession(voice.sessionId!)}>返回任务</button>
            )}
            <button type="button" className={styles.endButton} onClick={() => void end()}>结束</button>
          </footer>
        </>
      )}
    </section>
  )
}

function phaseText(phase: VoiceSnapshot['phase']): string {
  switch (phase) {
    case 'requesting-permission': return '请求麦克风'
    case 'connecting': return '正在接通'
    case 'listening': return '正在聆听'
    case 'thinking': return '正在思考'
    case 'agent-working': return '正在操作 DSH'
    case 'speaking': return '正在回答'
    case 'reconnecting': return '正在重连'
    case 'ending': return '正在结束'
    case 'idle': return '待机'
    case 'error': return '出错'
  }
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remainder = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}
