import type { Context } from '@deepseek-ai/cordis';
import { Config, type VoiceConfig } from './host/config.ts';
export { Config };
export type { VoiceConfig };
/** Host services required before the route can be mounted. */
export declare const inject: string[];
/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
export declare function apply(ctx: Context, config: VoiceConfig): void;
