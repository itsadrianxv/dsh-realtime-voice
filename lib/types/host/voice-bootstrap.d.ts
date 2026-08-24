import type { VoiceConfig } from './config.ts';
import type { VoiceContinuityState } from './voice-runtime.ts';
import { type DirectFunctionTool, type DirectMediaOffer } from '../direct-protocol.ts';
export declare const VOICE_FUNCTION_TOOLS: readonly DirectFunctionTool[];
export interface VoiceBootstrapStatus {
    running: boolean;
    blank: boolean;
    cwd?: string;
    title?: string;
    summary?: string;
}
export declare function buildVoiceInstructions(status: VoiceBootstrapStatus, continuity?: Pick<VoiceContinuityState, 'userTranscript' | 'assistantTranscript'>): string;
export declare function buildDirectMediaOfferBootstrap(config: VoiceConfig, instructions: string): DirectMediaOffer['bootstrap'];
