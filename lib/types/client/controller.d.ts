import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots';
import { type VoicePhase } from '../protocol.ts';
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
    elapsedSeconds: number;
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
    private ending;
    getSnapshot: () => VoiceSnapshot;
    subscribe: (listener: () => void) => (() => void);
    start(sessionId: string): Promise<void>;
    end(): Promise<void>;
    toggleMute(): void;
    cancelResponse(): void;
    dispose(): Promise<void>;
    private connect;
    private receive;
    private sendAudio;
    private sendControl;
    private scheduleReconnect;
    private tick;
    private fail;
    private cleanup;
    private update;
}
