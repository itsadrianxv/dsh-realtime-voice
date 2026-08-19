import z from '@deepseek-ai/schemastery';
import { type RealtimeVoiceModel } from '../models.ts';
/** Host-side realtime voice configuration; secrets are references, never values. */
export interface VoiceConfig {
    endpoint: string;
    apiKeyEnv: string;
    model: RealtimeVoiceModel;
    voice: string;
    turnDetection: 'server_vad' | 'smart_turn';
    silenceDurationMs: number;
    maxHistoryTurns: number;
    maxConnections: number;
    maxBinaryFrameBytes: number;
    connectTimeoutMs: number;
}
export declare const Config: z<VoiceConfig>;
