import { VOICE_DIRECT_PROTOCOL } from "./protocol.js";
//#region src/direct-protocol.ts
const VOICE_DIRECT_ROUTE = "/plugins/realtime-voice/v2/control";
const VOICE_DIRECT_STATUS_ROUTE = "/plugins/realtime-voice/v2/status";
const VOICE_DIRECT_BOOTSTRAP = "dsh.voice.bootstrap.v1";
const DIRECT_FUNCTION_ARGUMENT_MAX_BYTES = 16384;
const DIRECT_DSH_FUNCTION_NAMES = [
	"handoff_to_dsh_agent",
	"cancel_dsh_agent",
	"answer_dsh_approval",
	"answer_dsh_question"
];
function isDirectVoiceClientControl(value) {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "voice.hello") return isDirectHello(value);
	if (value.type === "voice.end") return value.reason === void 0 || isShortString(value.reason, 128);
	if (value.type === "voice.ping") return isFiniteNumber(value.sentAt);
	if (value.type === "media.refresh") return isShortString(value.previousOfferId, 128) && (value.reason === "expiring" || value.reason === "reconnect");
	if (value.type === "media.connected") return isShortString(value.offerId, 128) && isShortString(value.mediaSessionId, 256) && isFiniteNumber(value.connectedAt);
	if (value.type === "media.closed") return isShortString(value.offerId, 128) && isShortString(value.mediaSessionId, 256) && (value.code === void 0 || Number.isSafeInteger(value.code) && value.code >= 0) && (value.reason === void 0 || isShortString(value.reason, 256));
	if (value.type === "provider.function-call") return isShortString(value.offerId, 128) && isShortString(value.mediaSessionId, 256) && isShortString(value.callId, 128) && isDirectDshFunctionName(value.name) && typeof value.arguments === "string" && new TextEncoder().encode(value.arguments).byteLength <= 16384 && isDirectFunctionArguments(value.name, value.arguments);
	if (value.type === "voice.backend-ack") return isShortString(value.eventId, 256) && isNonNegativeInteger(value.eventSeq);
	if (value.type === "voice.approval-answer") return isShortString(value.approvalId, 256) && (value.outcome === "allowed-once" || value.outcome === "rejected");
	if (value.type === "voice.question-answer") return isShortString(value.requestId, 256) && isQuestionAnswers(value.answers);
	if (value.type === "client.metrics") return isMetricsMessage(value);
	return false;
}
function isDirectHello(value) {
	const client = value.client;
	const target = value.target;
	const resume = value.resume;
	return value.protocol === "dsh.voice.direct.v1" && isShortString(value.requestId, 128) && isRecord(client) && isPlatform(client.platform) && isShortString(client.version, 64) && typeof client.foregroundOnly === "boolean" && typeof client.websocketAuthorizationHeader === "boolean" && isRecord(target) && isShortString(target.sessionId, 256) && (resume === void 0 || isRecord(resume) && isShortString(resume.voiceSessionId, 256) && isNonNegativeInteger(resume.lastServerSeq) && isNonNegativeInteger(resume.lastBackendEventSeq));
}
function isMetricsMessage(value) {
	if (value.offerId !== void 0 && !isShortString(value.offerId, 128)) return false;
	if (value.mediaSessionId !== void 0 && !isShortString(value.mediaSessionId, 256)) return false;
	if (!isRecord(value.values)) return false;
	const allowed = /* @__PURE__ */ new Set([
		"capturedFrames",
		"playedFrames",
		"droppedFrames",
		"providerRttMs",
		"uplinkJitterMs",
		"downlinkJitterMs"
	]);
	const entries = Object.entries(value.values);
	return entries.length > 0 && entries.every(([key, metric]) => allowed.has(key) && isFiniteNumber(metric) && metric >= 0);
}
function isQuestionAnswers(value) {
	return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every((entry) => {
		if (!isRecord(entry)) return false;
		return Object.keys(entry).every((key) => key === "id" || key === "selected" || key === "custom") && isShortString(entry.id, 128) && Array.isArray(entry.selected) && entry.selected.length <= 16 && entry.selected.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256) && (entry.custom === void 0 || typeof entry.custom === "string" && entry.custom.length <= 4e3);
	});
}
function isDirectDshFunctionName(value) {
	return typeof value === "string" && DIRECT_DSH_FUNCTION_NAMES.includes(value);
}
function isDirectFunctionArguments(name, value) {
	let parsed;
	try {
		parsed = value.trim() === "" ? {} : JSON.parse(value);
	} catch {
		return false;
	}
	if (!isRecord(parsed)) return false;
	const keys = Object.keys(parsed);
	if (name === "handoff_to_dsh_agent") return keys.every((key) => key === "instruction") && isShortString(parsed.instruction, 12e3);
	if (name === "cancel_dsh_agent") return keys.every((key) => key === "reason") && (parsed.reason === void 0 || typeof parsed.reason === "string" && parsed.reason.length <= 1e3);
	if (name === "answer_dsh_approval") return keys.every((key) => key === "approval_id" || key === "decision") && isShortString(parsed.approval_id, 256) && (parsed.decision === "allowed-once" || parsed.decision === "rejected");
	return keys.every((key) => key === "request_id" || key === "answers") && isShortString(parsed.request_id, 256) && isQuestionAnswers(parsed.answers);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isShortString(value, maxLength) {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPlatform(value) {
	return value === "web" || value === "wechat-mini-program" || value === "ios" || value === "android" || value === "unknown";
}
//#endregion
export { DIRECT_DSH_FUNCTION_NAMES, DIRECT_FUNCTION_ARGUMENT_MAX_BYTES, VOICE_DIRECT_BOOTSTRAP, VOICE_DIRECT_PROTOCOL, VOICE_DIRECT_ROUTE, VOICE_DIRECT_STATUS_ROUTE, isDirectDshFunctionName, isDirectFunctionArguments, isDirectVoiceClientControl };

//# sourceMappingURL=direct-protocol.js.map