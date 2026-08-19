import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import {
  DEFAULT_REALTIME_VOICE_MODEL,
  DEFAULT_REALTIME_VOICE_TURN_DETECTION,
  isRealtimeVoiceModel,
  isRealtimeVoiceTurnDetection,
  type RealtimeVoiceModel,
  type RealtimeVoiceTurnDetection,
} from '../models.ts'

export interface VoiceModelSettingsValue {
  model: RealtimeVoiceModel
  turnDetection: RealtimeVoiceTurnDetection
  apiKeyEnv?: string
}

export interface VoiceModelSettingsSnapshot {
  available: boolean
  writable: boolean
  model: RealtimeVoiceModel
  turnDetection: RealtimeVoiceTurnDetection
  saving: boolean
  error: string | undefined
  apiKeyRef: string
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
  apiKeySaving: boolean
  apiKeyError: string | undefined
}

const DEFAULT_API_KEY_REF = 'DASHSCOPE_API_KEY'

/** Project one durable DSH settings namespace into an immediate two-model switch. */
export class VoiceModelSettingsController implements HostObservable<VoiceModelSettingsSnapshot> {
  private snapshot: VoiceModelSettingsSnapshot = {
    available: false,
    writable: false,
    model: DEFAULT_REALTIME_VOICE_MODEL,
    turnDetection: DEFAULT_REALTIME_VOICE_TURN_DETECTION,
    saving: false,
    error: undefined,
    apiKeyRef: DEFAULT_API_KEY_REF,
    apiKeyConfigured: false,
    apiKeyWritable: true,
    apiKeySaving: false,
    apiKeyError: undefined,
  }
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsScope<VoiceModelSettingsValue>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.unsubscribe = scope.subscribe(() => { this.adoptScope() })
    this.adoptScope()
    void this.readCredential()
  }

  getSnapshot = (): VoiceModelSettingsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async select(model: RealtimeVoiceModel): Promise<void> {
    if (!this.snapshot.available || !this.snapshot.writable || this.snapshot.saving || model === this.snapshot.model) return
    this.publish({ ...this.snapshot, saving: true, error: undefined })
    try {
      await this.scope.set('model', model)
      const accepted = this.scope.getSnapshot().value?.model
      if (accepted !== model) throw new Error('DSH 没有接受该模型设置。')
      this.publish({ ...this.snapshot, model, saving: false, error: undefined })
    } catch (error) {
      this.publish({
        ...this.snapshot,
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async selectTurnDetection(turnDetection: RealtimeVoiceTurnDetection): Promise<void> {
    if (!this.snapshot.available
      || !this.snapshot.writable
      || this.snapshot.saving
      || turnDetection === this.snapshot.turnDetection) return
    this.publish({ ...this.snapshot, saving: true, error: undefined })
    try {
      await this.scope.set('turnDetection', turnDetection)
      const accepted = this.scope.getSnapshot().value?.turnDetection
      if (accepted !== turnDetection) throw new Error('DSH 没有接受该打断模式。')
      this.publish({ ...this.snapshot, turnDetection, saving: false, error: undefined })
    } catch (error) {
      this.publish({
        ...this.snapshot,
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Write through DSH's write-only credential seam; the literal is never stored in this controller. */
  async saveApiKey(value: string): Promise<boolean> {
    const key = value.trim()
    if (key === '' || !this.snapshot.apiKeyWritable || this.snapshot.apiKeySaving) return false
    const ref = this.apiKeyRef()
    this.publish({ ...this.snapshot, apiKeySaving: true, apiKeyError: undefined })
    try {
      const response = await this.api.credentials.set({ ref, value: key })
      if (!response.result.ok) throw new Error('DSH credentials 拒绝了该密钥。')
      await this.readCredential()
      const configured = this.snapshot.apiKeyRef === ref && this.snapshot.apiKeyConfigured
      this.publish({
        ...this.snapshot,
        apiKeySaving: false,
        apiKeyError: configured ? undefined : '密钥写入后未能确认，请重试。',
      })
      return configured
    } catch {
      this.publish({ ...this.snapshot, apiKeySaving: false, apiKeyError: 'API Key 保存失败，请确认当前为本机 3080 WebUI。' })
      return false
    }
  }

  /** Refresh only when the Host reports that this card's credential changed. */
  refreshCredential(ref: string): void {
    if (ref === this.apiKeyRef()) void this.readCredential()
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private adoptScope(): void {
    const scope = this.scope.getSnapshot()
    const model = scope.value?.model
    const turnDetection = scope.value?.turnDetection
    const previousRef = this.snapshot.apiKeyRef
    const apiKeyRef = this.apiKeyRef()
    this.publish({
      ...this.snapshot,
      available: scope.status === 'ready'
        && isRealtimeVoiceModel(model)
        && isRealtimeVoiceTurnDetection(turnDetection),
      writable: scope.writable,
      ...(isRealtimeVoiceModel(model) ? { model } : {}),
      ...(isRealtimeVoiceTurnDetection(turnDetection) ? { turnDetection } : {}),
      apiKeyRef,
      ...(apiKeyRef === previousRef ? {} : { apiKeyConfigured: false }),
    })
    if (apiKeyRef !== previousRef) void this.readCredential()
  }

  private async readCredential(): Promise<void> {
    const ref = this.apiKeyRef()
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch {
      return
    }
    if (!response.result.ok || ref !== this.apiKeyRef()) return
    const credential = response.result.value.credentials[ref]
    this.publish({
      ...this.snapshot,
      apiKeyRef: ref,
      apiKeyConfigured: credential?.configured ?? false,
      apiKeyWritable: credential?.writable ?? true,
    })
  }

  private apiKeyRef(): string {
    const declared = this.scope.getSnapshot().value?.apiKeyEnv?.trim()
    return declared === undefined || declared === '' ? DEFAULT_API_KEY_REF : declared
  }

  private publish(next: VoiceModelSettingsSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** Reject malformed remote settings snapshots before they reach the switch. */
export function decodeVoiceModelSettings(value: unknown): VoiceModelSettingsValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const model = (value as Record<string, unknown>).model
  if (!isRealtimeVoiceModel(model)) return undefined
  const rawTurnDetection = (value as Record<string, unknown>).turnDetection
  const turnDetection = rawTurnDetection === undefined
    ? DEFAULT_REALTIME_VOICE_TURN_DETECTION
    : rawTurnDetection
  if (!isRealtimeVoiceTurnDetection(turnDetection)) return undefined
  const apiKeyEnv = (value as Record<string, unknown>).apiKeyEnv
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '')) return undefined
  return { model, turnDetection, ...(typeof apiKeyEnv === 'string' ? { apiKeyEnv } : {}) }
}
