//#region src/protocol.ts
/** Versioned client-neutral wire contract shared by WebUI and WeChat Mini Program clients. */
const VOICE_PROTOCOL = "dsh.voice.v1";
const VOICE_PROTOCOL_VERSION = 1;
const VOICE_ROUTE = "/plugins/realtime-voice/v1";
const INPUT_SAMPLE_RATE = 16e3;
const OUTPUT_SAMPLE_RATE = 24e3;
const AUDIO_CHANNELS = 1;
const AUDIO_MAGIC = [
	68,
	83,
	86,
	49
];
const AUDIO_HEADER_BYTES = 24;
let AudioFrameKind = /* @__PURE__ */ function(AudioFrameKind) {
	AudioFrameKind[AudioFrameKind["ClientInput"] = 1] = "ClientInput";
	AudioFrameKind[AudioFrameKind["ServerOutput"] = 2] = "ServerOutput";
	return AudioFrameKind;
}({});
let AudioFrameCodec = /* @__PURE__ */ function(AudioFrameCodec) {
	AudioFrameCodec[AudioFrameCodec["PcmS16Le"] = 1] = "PcmS16Le";
	return AudioFrameCodec;
}({});
let AudioFrameFlags = /* @__PURE__ */ function(AudioFrameFlags) {
	AudioFrameFlags[AudioFrameFlags["None"] = 0] = "None";
	AudioFrameFlags[AudioFrameFlags["Discontinuity"] = 1] = "Discontinuity";
	AudioFrameFlags[AudioFrameFlags["EndOfStream"] = 2] = "EndOfStream";
	return AudioFrameFlags;
}({});
/** Encode one ordered frame in network byte order for browsers and Mini Program ArrayBuffers. */
function encodeAudioFrame(kind, streamId, sequence, payload, metadata = {}) {
	const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
	const result = new ArrayBuffer(24 + bytes.byteLength);
	const view = new DataView(result);
	AUDIO_MAGIC.forEach((byte, index) => view.setUint8(index, byte));
	view.setUint8(4, 1);
	view.setUint8(5, kind);
	view.setUint8(6, 1);
	view.setUint8(7, metadata.flags ?? 0);
	view.setUint32(8, streamId);
	view.setUint32(12, sequence);
	view.setUint32(16, metadata.ptsMs ?? 0);
	view.setUint32(20, bytes.byteLength);
	new Uint8Array(result, 24).set(bytes);
	return result;
}
/** Decode and validate a binary voice frame without retaining the caller's mutable view. */
function decodeAudioFrame(data) {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.byteLength < 24) throw new Error("voice audio frame is shorter than its header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (AUDIO_MAGIC.some((byte, index) => view.getUint8(index) !== byte)) throw new Error("voice audio frame has an invalid magic");
	if (view.getUint8(4) !== 1) throw new Error("voice audio frame uses an unsupported version");
	const kind = view.getUint8(5);
	if (kind !== 1 && kind !== 2) throw new Error("voice audio frame has an unknown kind");
	const codec = view.getUint8(6);
	if (codec !== 1) throw new Error("voice audio frame uses an unsupported codec");
	const flags = view.getUint8(7);
	if ((flags & -4) !== 0) throw new Error("voice audio frame uses unsupported flags");
	if (view.getUint32(20) !== bytes.byteLength - 24) throw new Error("voice audio frame payload length does not match its header");
	return {
		kind,
		codec,
		flags,
		streamId: view.getUint32(8),
		sequence: view.getUint32(12),
		ptsMs: view.getUint32(16),
		payload: bytes.slice(24)
	};
}
/** Narrow an untrusted JSON value to the client control messages accepted by the Host. */
function isVoiceClientControl(value) {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	const message = value;
	if (message.type === "voice.end") return message.reason === void 0 || typeof message.reason === "string" && message.reason.length <= 128;
	if (message.type === "voice.cancel-response" || message.type === "voice.commit") return true;
	if (message.type === "voice.ping") return typeof message.sentAt === "number" && Number.isFinite(message.sentAt);
	if (message.type !== "voice.hello") return false;
	const client = message.client;
	const target = message.target;
	const audio = message.audio;
	return message.protocol === "dsh.voice.v1" && typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 128 && isClientPlatform(client?.platform) && typeof client.version === "string" && client.version.length <= 64 && client.binaryWebSocket === true && client.playbackClear === true && client.pcmS16leVerified === true && typeof client.foregroundOnly === "boolean" && (client.duplex === "full" || client.duplex === "best-effort" || client.duplex === "turn-based") && typeof target?.sessionId === "string" && target.sessionId.length > 0 && target.sessionId.length <= 256 && isPcmSpec(audio?.input) && isPcmSpec(audio?.output);
}
function isClientPlatform(value) {
	return value === "web" || value === "wechat-mini-program" || value === "ios" || value === "android" || value === "unknown";
}
function isPcmSpec(value) {
	if (typeof value !== "object" || value === null) return false;
	const spec = value;
	return spec.encoding === "pcm_s16le" && typeof spec.sampleRate === "number" && Number.isInteger(spec.sampleRate) && spec.sampleRate > 0 && spec.channels === 1 && typeof spec.frameDurationMs === "number" && Number.isFinite(spec.frameDurationMs) && spec.frameDurationMs > 0 && spec.frameDurationMs <= 1e3;
}
//#endregion
export { AUDIO_CHANNELS, AUDIO_HEADER_BYTES, AudioFrameCodec, AudioFrameFlags, AudioFrameKind, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL, VOICE_PROTOCOL_VERSION, VOICE_ROUTE, decodeAudioFrame, encodeAudioFrame, isVoiceClientControl };

//# sourceMappingURL=protocol.js.map