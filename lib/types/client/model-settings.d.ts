import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client';
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import { type RealtimeVoiceModel } from '../models.ts';
export interface VoiceModelSettingsValue {
    model: RealtimeVoiceModel;
    apiKeyEnv?: string;
}
export interface VoiceModelSettingsSnapshot {
    available: boolean;
    writable: boolean;
    model: RealtimeVoiceModel;
    saving: boolean;
    error: string | undefined;
    apiKeyRef: string;
    apiKeyConfigured: boolean;
    apiKeyWritable: boolean;
    apiKeySaving: boolean;
    apiKeyError: string | undefined;
}
/** Project one durable DSH settings namespace into an immediate two-model switch. */
export declare class VoiceModelSettingsController implements HostObservable<VoiceModelSettingsSnapshot> {
    private readonly scope;
    private readonly api;
    private snapshot;
    private readonly listeners;
    private readonly unsubscribe;
    constructor(scope: SettingsScope<VoiceModelSettingsValue>, api: Pick<IApiClient, 'credentials'>);
    getSnapshot: () => VoiceModelSettingsSnapshot;
    subscribe: (listener: () => void) => (() => void);
    select(model: RealtimeVoiceModel): Promise<void>;
    /** Write through DSH's write-only credential seam; the literal is never stored in this controller. */
    saveApiKey(value: string): Promise<boolean>;
    /** Refresh only when the Host reports that this card's credential changed. */
    refreshCredential(ref: string): void;
    dispose(): void;
    private adoptScope;
    private readCredential;
    private apiKeyRef;
    private publish;
}
/** Reject malformed remote settings snapshots before they reach the switch. */
export declare function decodeVoiceModelSettings(value: unknown): VoiceModelSettingsValue | undefined;
