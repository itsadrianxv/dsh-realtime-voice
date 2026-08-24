import z from '@deepseek-ai/schemastery';
import { type RealtimeVoiceModel, type RealtimeVoiceTurnDetection } from '../models.ts';
/** Host-side realtime voice configuration; secrets are references, never values. */
export interface VoiceConfig {
    endpoint: string;
    temporaryKeyEndpoint: string;
    temporaryKeyTtlSeconds: number;
    apiKeyEnv: string;
    model: RealtimeVoiceModel;
    voice: string;
    turnDetection: RealtimeVoiceTurnDetection;
    vadThreshold: number;
    silenceDurationMs: number;
    maxHistoryTurns: number;
    maxConnections: number;
    maxBinaryFrameBytes: number;
    connectTimeoutMs: number;
}
export declare const Config: z<VoiceConfig>;
