import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import { type VoiceApproval, type VoicePhase, type VoiceQuestion, type VoiceQuestionAnswer, type VoiceOccupancyStatus } from '../protocol.ts';
export type ClientVoicePhase = 'idle' | 'requesting-permission' | VoicePhase | 'error';
export interface VoiceSnapshot {
    phase: ClientVoicePhase;
    sessionId?: string;
    voiceSessionId?: string;
    muted: boolean;
    userTranscript: string;
    assistantTranscript: string;
    agentRunning: boolean;
    agentSummary?: string;
    pendingApproval?: VoiceApproval;
    pendingQuestion?: VoiceQuestion;
    providerModel?: string;
    turnDetection?: 'server_vad' | 'smart_turn';
    elapsedSeconds: number;
    occupancy?: VoiceOccupancyStatus;
    error?: string | undefined;
}
/** Root-lifetime call controller shared by the session button and frame overlay through inject hooks. */
export declare class VoiceCallController implements HostObservable<VoiceSnapshot> {
    private snapshot;
    private readonly listeners;
    private socket;
    private audio;
    private inputSequence;
    private inputStreamId;
    private providerReady;
    private startedAt;
    private timer;
    private reconnectTimer;
    private reconnectAttempt;
    private connectionEpoch;
    private lastReconnectError;
    private ending;
    private presenceTimer;
    getSnapshot: () => VoiceSnapshot;
    subscribe: (listener: () => void) => (() => void);
    startPresence(): void;
    start(sessionId: string): Promise<void>;
    end(): Promise<void>;
    toggleMute(): void;
    cancelResponse(): void;
    answerApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): void;
    answerQuestion(requestId: string, answers: VoiceQuestionAnswer[]): void;
    dispose(): Promise<void>;
    private connect;
    private receive;
    private sendAudio;
    private sendControl;
    private scheduleReconnect;
    private tick;
    /** Stop audible output before the server-side VAD event completes its round trip. */
    private handleLocalSpeechStart;
    private fail;
    private cleanup;
    private refreshPresence;
    private update;
}
