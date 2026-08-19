import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { VoiceSnapshot } from './controller.ts';
export interface VoiceOverlayInjected {
    hooks: {
        voice: HostObservable<VoiceSnapshot>;
    };
    end: () => void;
    toggleMute: () => void;
    cancelResponse: () => void;
    openSession: (sessionId: string) => void;
}
export type VoiceOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<VoiceOverlayInjected>;
/** Frame-wide call surface that remains visible while the user changes DSH sessions. */
export declare function VoiceOverlay({ useVoice, end, toggleMute, cancelResponse, openSession }: VoiceOverlayProps): import("react").JSX.Element | null;
