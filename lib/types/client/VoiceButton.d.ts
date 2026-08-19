import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { VoiceSnapshot } from './controller.ts';
export interface VoiceButtonInjected {
    hooks: {
        voice: HostObservable<VoiceSnapshot>;
    };
    toggle: () => void;
}
export type VoiceButtonProps = PropsRuntime<'conversation.input.right'> & InjectFace<VoiceButtonInjected>;
/** Compact call control in the official composer right-hand action slot. */
export declare function VoiceButton({ useVoice, toggle }: VoiceButtonProps): import("react").JSX.Element;
