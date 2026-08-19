import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { type RealtimeVoiceModel } from '../models.ts';
import type { VoiceModelSettingsSnapshot } from './model-settings.ts';
export interface VoiceSettingsCardInjected {
    hooks: {
        voiceModelSettings: HostObservable<VoiceModelSettingsSnapshot>;
    };
    selectModel: (model: RealtimeVoiceModel) => void;
    saveApiKey: (value: string) => Promise<boolean>;
}
export type VoiceSettingsCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<VoiceSettingsCardInjected>;
/** One native Plugins-settings card. Changes persist immediately and affect the next call. */
export declare function VoiceSettingsCard({ useVoiceModelSettings, selectModel, saveApiKey }: VoiceSettingsCardProps): import("react").JSX.Element | null;
