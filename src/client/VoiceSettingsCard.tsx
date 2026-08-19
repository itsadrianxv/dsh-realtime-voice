import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { useState } from 'react'
import {
  REALTIME_VOICE_MODELS,
  REALTIME_VOICE_TURN_DETECTION,
  type RealtimeVoiceModel,
  type RealtimeVoiceTurnDetection,
} from '../models.ts'
import type { VoiceModelSettingsSnapshot } from './model-settings.ts'
import styles from './voice.module.css'

export interface VoiceSettingsCardInjected {
  hooks: { voiceModelSettings: HostObservable<VoiceModelSettingsSnapshot> }
  selectModel: (model: RealtimeVoiceModel) => void
  selectTurnDetection: (mode: RealtimeVoiceTurnDetection) => void
  saveApiKey: (value: string) => Promise<boolean>
}

export type VoiceSettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & InjectFace<VoiceSettingsCardInjected>

/** One native Plugins-settings card. Changes persist immediately and affect the next call. */
export function VoiceSettingsCard({
  useVoiceModelSettings,
  selectModel,
  selectTurnDetection,
  saveApiKey,
}: VoiceSettingsCardProps) {
  const state = useVoiceModelSettings(snapshot => snapshot)
  const [apiKey, setApiKey] = useState('')
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  return (
    <li className={styles.settingsCard}>
      <div className={styles.settingsCardHeader}>
        <span className={styles.settingsCardIcon} aria-hidden><WaveGlyph /></span>
        <span className={styles.settingsCardHeading}>
          <strong>DSH 实时语音</strong>
          <span>选择语音理解、全双工通话和工具调度使用的百炼模型。</span>
        </span>
      </div>
      <div className={styles.settingsCardBody}>
        <div className={styles.settingsLabel}>实时语音模型</div>
        <div className={styles.modelSwitch} role="radiogroup" aria-label="实时语音模型">
          <ModelChoice
            title="Flash"
            detail="经济 · 低延迟 · 推荐日常使用"
            selected={state.model === REALTIME_VOICE_MODELS.flash}
            disabled={disabled}
            onClick={() => selectModel(REALTIME_VOICE_MODELS.flash)}
          />
          <ModelChoice
            title="Plus"
            detail="高质量 · 成本更高"
            selected={state.model === REALTIME_VOICE_MODELS.plus}
            disabled={disabled}
            onClick={() => selectModel(REALTIME_VOICE_MODELS.plus)}
          />
        </div>
        <p className={styles.settingsHint}>
          {state.saving ? '正在保存…' : '设置即时保存，从下一通电话开始生效；不会中断正在进行的通话。'}
        </p>
        <div className={styles.settingsSubsection}>
          <div className={styles.settingsLabel}>VAD 打断方式</div>
          <div className={styles.modelSwitch} role="radiogroup" aria-label="VAD 打断方式">
            <ModelChoice
              title="快速打断"
              detail="声学 VAD + 本地停播 · 推荐"
              selected={state.turnDetection === REALTIME_VOICE_TURN_DETECTION.fast}
              disabled={disabled}
              onClick={() => selectTurnDetection(REALTIME_VOICE_TURN_DETECTION.fast)}
            />
            <ModelChoice
              title="智能轮次"
              detail="过滤附和与背景音 · 更保守"
              selected={state.turnDetection === REALTIME_VOICE_TURN_DETECTION.semantic}
              disabled={disabled}
              onClick={() => selectTurnDetection(REALTIME_VOICE_TURN_DETECTION.semantic)}
            />
          </div>
          <p className={styles.settingsHint}>快速打断会在检测到你开口后立即清空本地播报，并取消云端旧响应。</p>
        </div>
        {state.error === undefined ? null : <p className={styles.settingsError} role="alert">{state.error}</p>}
        {state.writable ? null : <p className={styles.settingsHint}>当前连接不能修改主机设置，请在本机 3080 WebUI 中操作。</p>}
        <div className={styles.credentialSection}>
          <div className={styles.settingsLabel}>阿里云百炼 API Key</div>
          <div className={styles.credentialStatus} data-configured={state.apiKeyConfigured || undefined}>
            <span className={styles.credentialDot} />
            {state.apiKeyConfigured
              ? `已自动检测到 ${state.apiKeyRef}（环境变量或 DSH 凭据）`
              : `未检测到 ${state.apiKeyRef}`}
          </div>
          <div className={styles.credentialInputRow}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={styles.credentialInput}
              value={apiKey}
              placeholder={state.apiKeyConfigured ? '输入新 Key 可安全替换' : 'sk-…'}
              aria-label="阿里云百炼 API Key"
              disabled={!state.apiKeyWritable || state.apiKeySaving}
              onChange={event => setApiKey(event.target.value)}
            />
            <button
              type="button"
              className={styles.credentialSave}
              disabled={!state.apiKeyWritable || state.apiKeySaving || apiKey.trim() === ''}
              onClick={() => {
                void saveApiKey(apiKey).then(saved => { if (saved) setApiKey('') })
              }}
            >{state.apiKeySaving ? '保存中…' : '保存 Key'}</button>
          </div>
          <p className={styles.settingsHint}>密钥通过 DSH 官方 credentials 写入，只能检查是否存在，浏览器无法回读明文。</p>
          {state.apiKeyError === undefined ? null : <p className={styles.settingsError} role="alert">{state.apiKeyError}</p>}
        </div>
      </div>
    </li>
  )
}

function ModelChoice(props: {
  title: string
  detail: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      className={`${styles.modelChoice} ${props.selected ? styles.modelChoiceSelected : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className={styles.modelChoiceTitle}>{props.title}</span>
      <span className={styles.modelChoiceDetail}>{props.detail}</span>
      <span className={styles.radioDot} aria-hidden />
    </button>
  )
}

function WaveGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={styles.icon}>
      <path d="M4 13v-2M8 16V8M12 19V5M16 16V8M20 13v-2" />
    </svg>
  )
}
