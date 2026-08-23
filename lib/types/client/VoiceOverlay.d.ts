import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { VoiceQuestionAnswer } from '../protocol.ts';
import type { VoiceSnapshot } from './controller.ts';
export interface VoiceOverlayInjected {
    hooks: {
        voice: HostObservable<VoiceSnapshot>;
    };
    end: () => void;
    toggleMute: () => void;
    cancelResponse: () => void;
    answerApproval: (approvalId: string, outcome: 'allowed-once' | 'rejected') => void;
    answerQuestion: (requestId: string, answers: VoiceQuestionAnswer[]) => void;
    openSession: (sessionId: string) => void;
}
export type VoiceOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<VoiceOverlayInjected>;
/** Root-level movable call surface that remains visible while the user changes DSH sessions. */
export declare function VoiceOverlay({ useVoice, useSessions, end, toggleMute, cancelResponse, answerApproval, answerQuestion, openSession, }: VoiceOverlayProps): import("react").JSX.Element | null;
