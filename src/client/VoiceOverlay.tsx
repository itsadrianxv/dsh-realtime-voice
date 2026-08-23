import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { realtimeVoiceModelLabel, realtimeVoiceTurnDetectionLabel } from '../models.ts'
import type { VoiceQuestionAnswer } from '../protocol.ts'
import type { VoiceSnapshot } from './controller.ts'
import {
  clampFloatingPosition,
  defaultFloatingPosition,
  moveFloatingPosition,
  type FloatingPosition,
} from './floating-position.ts'
import styles from './voice.module.css'

export interface VoiceOverlayInjected {
  hooks: { voice: HostObservable<VoiceSnapshot> }
  end: () => void
  toggleMute: () => void
  cancelResponse: () => void
  answerApproval: (approvalId: string, outcome: 'allowed-once' | 'rejected') => void
  answerQuestion: (requestId: string, answers: VoiceQuestionAnswer[]) => void
  openSession: (sessionId: string) => void
}
export type VoiceOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<VoiceOverlayInjected>

interface DragState {
  pointerId: number
  pointerStart: FloatingPosition
  origin: FloatingPosition
}

/** Root-level movable call surface that remains visible while the user changes DSH sessions. */
export function VoiceOverlay({
  useVoice,
  useSessions,
  end,
  toggleMute,
  cancelResponse,
  answerApproval,
  answerQuestion,
  openSession,
}: VoiceOverlayProps) {
  const voice = useVoice(snapshot => snapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [position, setPosition] = useState<FloatingPosition>()
  const panelRef = useRef<HTMLElement>(null)
  const dragRef = useRef<DragState>()
  const movedRef = useRef(false)
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, { selected: string[]; custom: string }>>({})
  const boundSession = useSessions(state => voice.sessionId === undefined
    ? undefined
    : state.byId[voice.sessionId as SessionId])
  const currentSessionId = useSessions(state => state.current)
  const viewingOtherSession = voice.sessionId !== undefined && currentSessionId !== voice.sessionId

  useEffect(() => {
    if (voice.phase === 'requesting-permission') setCollapsed(false)
  }, [voice.phase])

  useEffect(() => {
    setQuestionAnswers({})
  }, [voice.pendingQuestion?.requestId])

  useEffect(() => {
    const panel = panelRef.current
    if (panel === null || voice.phase === 'idle') return
    let frame = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = panel.getBoundingClientRect()
        const viewport = { width: window.innerWidth, height: window.innerHeight }
        const size = { width: rect.width, height: rect.height }
        setPosition(current => current === undefined
          ? defaultFloatingPosition(viewport, size)
          : clampFloatingPosition(current, viewport, size))
      })
    }
    fit()
    window.addEventListener('resize', fit)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit)
    observer?.observe(panel)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', fit)
      observer?.disconnect()
    }
  }, [collapsed, voice.phase])

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || panelRef.current === null) return
    if (!collapsed && (event.target as Element).closest('button') !== null) return
    const rect = panelRef.current.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: { x: rect.left, y: rect.top },
    }
    movedRef.current = false
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    const panel = panelRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId || panel === null) return
    if (Math.abs(event.clientX - drag.pointerStart.x) + Math.abs(event.clientY - drag.pointerStart.y) > 4) {
      movedRef.current = true
    }
    const rect = panel.getBoundingClientRect()
    setPosition(moveFloatingPosition(
      drag.origin,
      drag.pointerStart,
      { x: event.clientX, y: event.clientY },
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
    ))
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = undefined
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  if (voice.phase === 'idle') return null
  const floatingStyle: CSSProperties | undefined = position === undefined
    ? undefined
    : { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }

  if (collapsed && voice.phase !== 'error') {
    return (
      <section
        ref={panelRef}
        className={`${styles.voiceOrb} ${dragging ? styles.dragging : ''}`}
        style={floatingStyle}
        data-phase={voice.phase}
        aria-label={`实时语音：${phaseText(voice.phase)}`}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button
          type="button"
          className={styles.orbButton}
          aria-label="展开实时语音"
          title="拖动悬浮球；点击展开"
          onClick={() => {
            if (movedRef.current) {
              movedRef.current = false
              return
            }
            setCollapsed(false)
          }}
        >
          <span className={styles.orbWaves} aria-hidden><i /><i /><i /><i /><i /></span>
          <span className={styles.orbTime}>{formatElapsed(voice.elapsedSeconds)}</span>
        </button>
      </section>
    )
  }

  return (
    <section
      ref={panelRef}
      className={`${styles.overlay} ${voice.phase === 'error' ? styles.overlayError : ''} ${dragging ? styles.dragging : ''}`}
      style={floatingStyle}
      aria-label="实时语音通话"
    >
      <header
        className={`${styles.overlayHeader} ${styles.dragHandle}`}
        title="拖动语音窗口"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div>
          <div className={styles.eyebrow}>DSH 实时语音</div>
          <div className={styles.phaseLine}>
            <span className={styles.liveDot} />
            {phaseText(voice.phase)} · {formatElapsed(voice.elapsedSeconds)}
          </div>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.agentState}>{voice.agentRunning ? 'Agent 工作中' : 'Agent 待命'}</div>
          {voice.phase === 'error' ? null : (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="收起为悬浮球"
              title="收起为悬浮球"
              onClick={() => setCollapsed(true)}
            >−</button>
          )}
        </div>
      </header>
      {voice.phase === 'error' ? (
        <>
          <div className={styles.errorText}>{voice.error}</div>
          <button type="button" className={styles.secondaryButton} onClick={() => void end()}>关闭</button>
        </>
      ) : (
        <>
          <div className={styles.bindingCard}>
            <div className={styles.bindingLabel}>本次通话一对一绑定</div>
            <div className={styles.bindingTitle}>{boundSession?.displayTitle ?? '当前 DSH 会话'}</div>
            <div className={styles.bindingMeta}>
              {boundSession?.blank === true ? '空白新会话 · 首个 Agent 指令会写入第一轮' : '工作指令与 Agent 结果保存在此线程'}
              {' · '}{realtimeVoiceModelLabel(voice.providerModel)}
              {' · '}{realtimeVoiceTurnDetectionLabel(voice.turnDetection)}
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
          {voice.pendingApproval === undefined ? null : (
            <section className={styles.interactionCard} aria-label="DSH 操作审批">
              <strong>需要你的批准</strong>
              <div className={styles.interactionTitle}>{voice.pendingApproval.toolName}</div>
              {voice.pendingApproval.reason === undefined ? null : (
                <p className={styles.interactionDetail}>{voice.pendingApproval.reason}</p>
              )}
              <div className={styles.interactionActions}>
                <button
                  type="button"
                  className={styles.rejectButton}
                  onClick={() => answerApproval(voice.pendingApproval!.approvalId, 'rejected')}
                >拒绝</button>
                <button
                  type="button"
                  className={styles.allowButton}
                  onClick={() => answerApproval(voice.pendingApproval!.approvalId, 'allowed-once')}
                >仅允许这一次</button>
              </div>
            </section>
          )}
          {voice.pendingQuestion === undefined ? null : (
            <section className={styles.interactionCard} aria-label="DSH Agent 追问">
              <strong>Agent 需要你确认</strong>
              {voice.pendingQuestion.questions.map((question) => {
                const current = questionAnswers[question.id] ?? { selected: [], custom: '' }
                return (
                  <div className={styles.questionBlock} key={question.id}>
                    <div className={styles.interactionTitle}>{question.header ?? question.question}</div>
                    {question.header === undefined ? null : <p className={styles.interactionDetail}>{question.question}</p>}
                    {question.detail === undefined ? null : <p className={styles.interactionDetail}>{question.detail}</p>}
                    {question.options?.map(option => {
                      const checked = current.selected.includes(option.label)
                      return (
                        <label className={styles.questionOption} key={option.label}>
                          <input
                            type={question.multiSelect === true ? 'checkbox' : 'radio'}
                            name={`${voice.pendingQuestion!.requestId}:${question.id}`}
                            checked={checked}
                            onChange={() => setQuestionAnswers(previous => ({
                              ...previous,
                              [question.id]: {
                                ...current,
                                selected: question.multiSelect === true
                                  ? checked
                                    ? current.selected.filter(value => value !== option.label)
                                    : [...current.selected, option.label]
                                  : [option.label],
                              },
                            }))}
                          />
                          <span>{option.label}{option.description === undefined ? '' : ` — ${option.description}`}</span>
                        </label>
                      )
                    })}
                    <input
                      className={styles.questionCustom}
                      value={current.custom}
                      placeholder={question.options === undefined ? '输入回答' : '其他补充（可选）'}
                      onChange={event => setQuestionAnswers(previous => ({
                        ...previous,
                        [question.id]: { ...current, custom: event.target.value },
                      }))}
                    />
                  </div>
                )
              })}
              <div className={styles.interactionActions}>
                <button
                  type="button"
                  className={styles.allowButton}
                  onClick={() => {
                    const answers = voice.pendingQuestion!.questions.map(question => {
                      const answer = questionAnswers[question.id] ?? { selected: [], custom: '' }
                      return {
                        id: question.id,
                        selected: answer.selected,
                        ...(answer.custom.trim() === '' ? {} : { custom: answer.custom.trim() }),
                      }
                    }).filter(answer => answer.selected.length > 0 || answer.custom !== undefined)
                    answerQuestion(voice.pendingQuestion!.requestId, answers)
                  }}
                >提交回答</button>
              </div>
            </section>
          )}
          {voice.error === undefined ? null : <div className={styles.inlineError}>{voice.error}</div>}
          <footer className={styles.controls}>
            <button type="button" className={styles.secondaryButton} onClick={toggleMute}>
              {voice.muted ? '取消静音' : '静音'}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={cancelResponse}>立即打断</button>
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
