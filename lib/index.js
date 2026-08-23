import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL, VOICE_ROUTE, VOICE_STATUS_ROUTE, decodeAudioFrame, encodeAudioFrame, isVoiceClientControl } from "./protocol.js";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import WebSocket, { WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import { SessionId } from "@deepseek-ai/dsh-session/types";
//#region src/models.ts
/** Realtime voice models supported by the built-in DashScope provider. */
const REALTIME_VOICE_MODELS = {
	flash: "qwen-audio-3.0-realtime-flash",
	plus: "qwen-audio-3.0-realtime-plus"
};
const REALTIME_VOICE_TURN_DETECTION = {
	fast: "server_vad",
	semantic: "smart_turn"
};
const DEFAULT_REALTIME_VOICE_MODEL = REALTIME_VOICE_MODELS.plus;
const DEFAULT_REALTIME_VOICE_TURN_DETECTION = REALTIME_VOICE_TURN_DETECTION.fast;
const REALTIME_VOICE_SETTINGS_NAMESPACE = "realtime-voice";
//#endregion
//#region src/host/config.ts
const Config = z.object({
	endpoint: z.string().default("wss://dashscope.aliyuncs.com/api-ws/v1/realtime"),
	apiKeyEnv: z.string().default("DASHSCOPE_API_KEY"),
	model: z.union([REALTIME_VOICE_MODELS.flash, REALTIME_VOICE_MODELS.plus]).default(DEFAULT_REALTIME_VOICE_MODEL),
	voice: z.string().default("longanqian"),
	turnDetection: z.union([REALTIME_VOICE_TURN_DETECTION.fast, REALTIME_VOICE_TURN_DETECTION.semantic]).default(DEFAULT_REALTIME_VOICE_TURN_DETECTION),
	vadThreshold: z.number().min(-1).max(1).default(.35),
	silenceDurationMs: z.natural().min(200).max(6e3).default(500),
	maxHistoryTurns: z.natural().min(1).max(50).default(20),
	maxConnections: z.natural().min(1).max(32).default(4),
	maxBinaryFrameBytes: z.natural().min(1024).max(1048576).default(65536),
	connectTimeoutMs: z.natural().min(1e3).max(6e4).default(15e3)
});
//#endregion
//#region src/host/dashscope-realtime.ts
/**
* One upstream Qwen-Audio Realtime session. It remains the responsive
* conversational surface and may semantically hand work to DSH through a
* deliberately small Function Calling vocabulary.
*/
var DashScopeRealtime = class {
	config;
	apiKey;
	instructions;
	tools;
	callbacks;
	socketFactory;
	socket;
	queuedAnnouncements = [];
	announcedIds = /* @__PURE__ */ new Set();
	responseActive = false;
	responseRequested = false;
	followupResponsePending = false;
	inputSpeechActive = false;
	closed = false;
	constructor(config, apiKey, instructions, tools, callbacks, socketFactory = (url, options) => new WebSocket(url, options)) {
		this.config = config;
		this.apiKey = apiKey;
		this.instructions = instructions;
		this.tools = tools;
		this.callbacks = callbacks;
		this.socketFactory = socketFactory;
	}
	/** Connect and resolve only after the upstream session accepts its configuration. */
	async connect() {
		const url = new URL(this.config.endpoint);
		if (url.protocol !== "wss:") throw new Error("DashScope realtime endpoint must use wss://");
		url.searchParams.set("model", this.config.model);
		const socket = this.socketFactory(url, { headers: {
			Authorization: `Bearer ${this.apiKey}`,
			"User-Agent": "@harness-remote/dsh-realtime-voice"
		} });
		this.socket = socket;
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(/* @__PURE__ */ new Error("DashScope realtime connection timed out"));
				socket.close();
			}, this.config.connectTimeoutMs);
			let settled = false;
			const fail = (error) => {
				clearTimeout(timeout);
				if (!settled) {
					settled = true;
					reject(error);
				} else if (!this.closed) this.emitEvent({
					type: "error",
					error: {
						type: "transport_error",
						message: error.message
					}
				});
			};
			socket.on("error", fail);
			socket.on("message", (raw) => {
				try {
					const event = JSON.parse(raw.toString());
					if (event.type === "session.created") this.send({
						type: "session.update",
						session: {
							modalities: ["text", "audio"],
							voice: this.config.voice,
							instructions: this.instructions,
							input_audio_format: "pcm",
							output_audio_format: "pcm",
							max_history_turns: this.config.maxHistoryTurns,
							tools: this.tools,
							turn_detection: this.config.turnDetection === "server_vad" ? {
								type: "server_vad",
								threshold: this.config.vadThreshold,
								silence_duration_ms: this.config.silenceDurationMs
							} : { type: "smart_turn" }
						}
					});
					if (event.type === "session.updated") {
						clearTimeout(timeout);
						settled = true;
						resolve();
					}
					this.handleEvent(event);
				} catch (error) {
					this.emitEvent({
						type: "error",
						error: {
							type: "provider_event_error",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				}
			});
			socket.once("close", (code, reason) => {
				clearTimeout(timeout);
				if (!this.closed) this.emitEvent({
					type: "transport.closed",
					code,
					reason: reason.toString()
				});
			});
		});
	}
	appendAudio(pcm) {
		this.send({
			type: "input_audio_buffer.append",
			audio: Buffer.from(pcm).toString("base64")
		});
	}
	commitAudio() {
		this.send({ type: "input_audio_buffer.commit" });
		this.send({ type: "response.create" });
	}
	cancelResponse() {
		this.send({ type: "response.cancel" });
	}
	/** Return a completed Function Call without blocking the live conversation. */
	completeFunctionCall(callId, output) {
		if (this.closed) return;
		this.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify(output)
			}
		});
		this.requestResponseAfterCurrent();
	}
	/**
	* Inject an authoritative backend event into the Realtime conversation.
	* Qwen turns the tagged event into a short spoken update; it never treats it
	* as a fresh user task.
	*/
	announceBackendEvent(id, text) {
		this.queueAnnouncement(id, `[BACKEND]\n${text.slice(0, 4e3)}`);
	}
	queueAnnouncement(id, text) {
		if (this.closed || this.announcedIds.has(id)) return;
		this.announcedIds.add(id);
		this.queuedAnnouncements.push({
			id,
			text
		});
		if (this.queuedAnnouncements.length > 4) this.queuedAnnouncements.shift();
		this.drainAgentAnnouncements();
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.socket?.close(1e3, "voice session closed");
		this.socket = void 0;
	}
	handleEvent(event) {
		this.emitEvent(event);
		if (event.type === "input_audio_buffer.speech_started") {
			this.inputSpeechActive = true;
			return;
		}
		if (event.type === "input_audio_buffer.speech_stopped") {
			this.inputSpeechActive = false;
			return;
		}
		if (event.type === "response.created") {
			this.responseActive = true;
			this.responseRequested = false;
			return;
		}
		if (event.type !== "response.done") return;
		this.responseActive = false;
		this.responseRequested = false;
		if (this.followupResponsePending) {
			this.followupResponsePending = false;
			this.requestResponse();
			return;
		}
		this.drainAgentAnnouncements();
	}
	drainAgentAnnouncements() {
		if (this.closed || this.inputSpeechActive || this.responseActive || this.responseRequested || this.queuedAnnouncements.length === 0) return;
		const announcement = this.queuedAnnouncements.shift();
		this.send({
			type: "conversation.item.create",
			item: {
				id: announcement.id,
				type: "message",
				role: "user",
				content: [{
					type: "input_text",
					text: announcement.text
				}]
			}
		});
		this.requestResponse();
	}
	requestResponse() {
		if (this.closed || this.responseActive || this.responseRequested) {
			this.followupResponsePending = true;
			return;
		}
		this.responseRequested = true;
		this.send({ type: "response.create" });
	}
	requestResponseAfterCurrent() {
		if (this.responseActive || this.responseRequested || this.inputSpeechActive) {
			this.followupResponsePending = true;
			return;
		}
		this.requestResponse();
	}
	/** A plugin callback must never be able to escape a ws EventEmitter turn and crash DSH. */
	emitEvent(event) {
		try {
			this.callbacks.onEvent(event);
		} catch {}
	}
	send(message) {
		if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("DashScope realtime socket is not open");
		this.socket.send(JSON.stringify(message));
	}
};
//#endregion
//#region src/host/dsh-coordinator.ts
function createDshVoiceCoordinatorState() {
	return {
		handoffs: /* @__PURE__ */ new Map(),
		pendingApprovals: /* @__PURE__ */ new Map(),
		pendingQuestions: /* @__PURE__ */ new Map()
	};
}
/**
* The DSH execution plane for one live call. Qwen owns the realtime
* conversation and invokes this coordinator only for semantic handoffs,
* corrections, cancellation, approvals, and structured user questions.
*/
var DshVoiceCoordinator = class {
	ctx;
	sessionId;
	handoffs;
	pendingApprovals;
	pendingQuestions;
	constructor(ctx, sessionId, state = createDshVoiceCoordinatorState()) {
		this.ctx = ctx;
		this.sessionId = sessionId;
		this.handoffs = state.handoffs;
		this.pendingApprovals = state.pendingApprovals;
		this.pendingQuestions = state.pendingQuestions;
	}
	/** Start work when idle, or steer the active turn when DSH is already busy. */
	async handoff(request, spokenInput) {
		const normalizedRequest = request.trim();
		if (normalizedRequest === "") throw new Error("Realtime handoff request is empty");
		const state = await this.sessionState(this.sessionId);
		const mode = state.running ? "steer" : "queue";
		const handoffId = `handoff_${randomUUID()}`;
		const record = {
			handoffId,
			sessionId: this.sessionId,
			mode,
			request: normalizedRequest,
			spokenInput: spokenInput.trim(),
			status: state.running ? "running" : "accepted",
			createdAt: Date.now()
		};
		this.handoffs.set(handoffId, record);
		const response = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(this.sessionId),
				mode,
				content: [{
					type: "text",
					text: handoffMessage(record)
				}]
			}
		});
		if (!response.result.ok) {
			record.status = "failed";
			throw new Error(response.result.error.message);
		}
		return { ...record };
	}
	/** Cancel the authoritative bound DSH turn; there is no shadow worker. */
	async cancel(reason = "") {
		const response = await this.ctx.apiProxy.sessions.cancel({
			rpcId: this.rpcId(),
			payload: { sessionId: SessionId(this.sessionId) }
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		for (const record of this.handoffs.values()) if (record.status === "accepted" || record.status === "running" || record.status === "needs-input") record.status = "cancelled";
		return {
			sessionId: this.sessionId,
			status: "cancelled"
		};
	}
	markTurnStarted(turn) {
		for (const record of this.activeHandoffs()) {
			record.status = "running";
			record.turn ??= turn;
		}
	}
	markNeedsInput() {
		for (const record of this.activeHandoffs()) record.status = "needs-input";
	}
	markTurnEnded(turn, reason) {
		for (const record of this.activeHandoffs()) {
			if (record.turn !== void 0 && record.turn !== turn) continue;
			record.turn ??= turn;
			record.status = reason === "cancelled" || reason === "interrupted" ? "cancelled" : reason === "error" || reason === "failed" ? "failed" : "completed";
		}
	}
	rememberApproval(approval) {
		this.pendingApprovals.set(approval.approvalId, approval);
		this.markNeedsInput();
	}
	forgetApproval(approvalId) {
		this.pendingApprovals.delete(approvalId);
	}
	listPendingApprovals() {
		return [...this.pendingApprovals.values()].map((value) => ({ ...value }));
	}
	async resolveApproval(approvalId, outcome) {
		const pending = this.pendingApprovals.get(approvalId);
		if (pending === void 0) throw new Error(`DSH approval is no longer pending: ${approvalId}`);
		const receipt = await this.ctx.apiProxy.respond({
			type: "client-response",
			rpcId: RpcId(pending.rpcId),
			result: {
				ok: true,
				value: {
					sessionId: SessionId(pending.sessionId),
					approvalId: pending.approvalId,
					outcome
				}
			}
		});
		if (!receipt.accepted) throw new Error(`DSH approval response was rejected: ${receipt.reason}`);
		return {
			approvalId,
			outcome,
			accepted: true
		};
	}
	rememberQuestion(question) {
		this.pendingQuestions.set(question.rpcId, question);
		this.markNeedsInput();
	}
	forgetQuestion(rpcId) {
		this.pendingQuestions.delete(rpcId);
	}
	listPendingQuestions() {
		return [...this.pendingQuestions.values()].map((value) => ({
			...value,
			questions: value.questions.map((question) => ({
				...question,
				...question.options === void 0 ? {} : { options: question.options.map((option) => ({ ...option })) }
			}))
		}));
	}
	async answerQuestion(rpcId, answers) {
		const pending = this.pendingQuestions.get(rpcId);
		if (pending === void 0) throw new Error(`DSH question is no longer pending: ${rpcId}`);
		const receipt = await this.ctx.apiProxy.respond({
			type: "client-response",
			rpcId: RpcId(rpcId),
			result: {
				ok: true,
				value: {
					sessionId: SessionId(pending.sessionId),
					answer: { answers }
				}
			}
		});
		if (!receipt.accepted) throw new Error(`DSH question response was rejected: ${receipt.reason}`);
		return {
			rpcId,
			accepted: true
		};
	}
	get active() {
		return this.activeHandoffs().length > 0;
	}
	activeHandoffs() {
		return [...this.handoffs.values()].filter((record) => record.status === "accepted" || record.status === "running" || record.status === "needs-input");
	}
	async sessionState(sessionId) {
		const response = await this.ctx.apiProxy.sessions.list({
			rpcId: this.rpcId(),
			payload: {}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		const item = response.result.value.items.find((candidate) => candidate.sessionId === sessionId);
		if (item === void 0) throw new Error(`DSH session not found: ${sessionId}`);
		const title = projectionTitle$1(item.projections?.values);
		return {
			sessionId,
			running: item.running,
			...item.cwd === void 0 ? {} : { cwd: item.cwd },
			...title === void 0 ? {} : { title }
		};
	}
	rpcId() {
		return RpcId(randomUUID());
	}
};
function handoffMessage(record) {
	const spoken = record.spokenInput === "" ? "" : `\n  <spoken_input>${escapeXml(record.spokenInput)}</spoken_input>`;
	return `<realtime_delegation handoff_id="${record.handoffId}" mode="${record.mode}">
  <input>${escapeXml(record.request)}</input>${spoken}
</realtime_delegation>

This is an execution handoff from the live voice surface. Preserve the user's constraints and use the session's normal tools, permissions, project context, and memory. Report useful progress in ordinary assistant commentary. If approval or a user decision is needed, request it through the normal DSH mechanism. Do not merely explain manual steps when the available tools can perform the task.`;
}
function escapeXml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function projectionTitle$1(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const title = value.title;
	if (typeof title === "string" && title.trim() !== "") return title.trim();
	if (typeof title !== "object" || title === null) return void 0;
	const nested = title.title;
	return typeof nested === "string" && nested.trim() !== "" ? nested.trim() : void 0;
}
//#endregion
//#region src/host/dsh-session-state.ts
/** Read-only state used to bind the audio transport to one authoritative DSH Agent. */
var DshVoiceSession = class {
	ctx;
	sessionId;
	constructor(ctx, sessionId) {
		this.ctx = ctx;
		this.sessionId = sessionId;
	}
	async snapshot() {
		const response = await this.ctx.apiProxy.sessions.list({
			rpcId: this.rpcId(),
			payload: {}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		const item = response.result.value.items.find((candidate) => candidate.sessionId === this.sessionId);
		if (item === void 0) throw new Error(`DSH session not found: ${this.sessionId}`);
		const title = projectionTitle(item.projections?.values);
		const summary = await this.lastAssistantText().catch(() => void 0);
		return {
			sessionId: this.sessionId,
			running: item.running,
			blank: item.blank,
			...item.cwd === void 0 ? {} : { cwd: item.cwd },
			...title === void 0 ? {} : { title },
			...summary === void 0 ? {} : { summary }
		};
	}
	async lastAssistantText() {
		const response = await this.ctx.apiProxy.sessions.history({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(this.sessionId),
				maxMessages: 12
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		for (let index = response.result.value.events.length - 1; index >= 0; index -= 1) {
			const text = assistantText(response.result.value.events[index]?.event);
			if (text !== void 0) return text.slice(0, 1200);
		}
	}
	rpcId() {
		return RpcId(randomUUID());
	}
};
function projectionTitle(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const title = value.title;
	if (typeof title === "string" && title.trim() !== "") return title.trim();
	if (typeof title !== "object" || title === null) return void 0;
	const nested = title.title;
	return typeof nested === "string" && nested.trim() !== "" ? nested.trim() : void 0;
}
function assistantText(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const event = value;
	if (event.type !== "assistant/message") return void 0;
	const message = event.data?.message ?? event.message;
	if (!Array.isArray(message?.content)) return void 0;
	const text = message.content.map((block) => {
		if (typeof block !== "object" || block === null) return "";
		const entry = block;
		return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
	}).filter(Boolean).join("\n").trim();
	return text === "" ? void 0 : text;
}
//#endregion
//#region src/host/websocket-send.ts
/** `ws` reports a successful send with `null`, despite older typings allowing `undefined`. */
function isWebSocketSendError(error) {
	return error != null;
}
//#endregion
//#region src/host/voice-runtime.ts
/**
* Short-lived continuity ledger for transport reconnects. DSH remains the
* durable source of task truth; this ledger only restores the conversational
* edge and any interaction card that was already shown to the caller.
*/
var VoiceRuntime = class {
	retentionMs;
	calls = /* @__PURE__ */ new Map();
	activeLease;
	constructor(retentionMs = 6e5) {
		this.retentionMs = retentionMs;
	}
	acquireLease(request) {
		this.sweep();
		const active = this.activeLease;
		const mayResume = active !== void 0 && request.resumeId === active.voiceSessionId && request.sessionId === active.sessionId;
		if (active !== void 0 && !mayResume) return {
			ok: false,
			occupancy: this.occupancy()
		};
		const resumed = request.resumeId === void 0 ? void 0 : this.calls.get(request.resumeId);
		let state;
		if (resumed !== void 0 && resumed.sessionId === request.sessionId) {
			resumed.lastSeenAt = Date.now();
			state = resumed;
		} else {
			const now = Date.now();
			state = {
				id: randomUUID(),
				sessionId: request.sessionId,
				createdAt: now,
				lastSeenAt: now,
				userTranscript: "",
				assistantTranscript: "",
				coordinator: createDshVoiceCoordinatorState()
			};
			this.calls.set(state.id, state);
		}
		const previousRevoke = mayResume ? active?.revoke : void 0;
		const startedAt = mayResume && active !== void 0 ? active.startedAt : Date.now();
		this.activeLease = {
			connectionId: request.connectionId,
			platform: request.platform,
			clientVersion: request.clientVersion,
			sessionId: request.sessionId,
			voiceSessionId: state.id,
			startedAt,
			lastSeenAt: Date.now(),
			revoke: request.revoke
		};
		previousRevoke?.();
		return {
			ok: true,
			state,
			resumed: resumed !== void 0
		};
	}
	touch(state) {
		state.lastSeenAt = Date.now();
		if (this.activeLease?.voiceSessionId === state.id) this.activeLease.lastSeenAt = state.lastSeenAt;
	}
	release(connectionId) {
		if (this.activeLease?.connectionId === connectionId) this.activeLease = void 0;
	}
	occupancy() {
		const lease = this.activeLease;
		if (lease === void 0) return {
			protocol: VOICE_PROTOCOL,
			active: false
		};
		return {
			protocol: VOICE_PROTOCOL,
			active: true,
			owner: {
				platform: lease.platform,
				clientVersion: lease.clientVersion,
				sessionId: lease.sessionId,
				voiceSessionId: lease.voiceSessionId,
				startedAt: lease.startedAt,
				lastSeenAt: lease.lastSeenAt
			}
		};
	}
	clear() {
		this.activeLease?.revoke();
		this.activeLease = void 0;
		this.calls.clear();
	}
	sweep() {
		const expiredBefore = Date.now() - this.retentionMs;
		for (const [id, state] of this.calls) if (id !== this.activeLease?.voiceSessionId && state.lastSeenAt < expiredBefore) this.calls.delete(id);
	}
};
//#endregion
//#region src/host/voice-connection.ts
/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
var VoiceConnection = class {
	ctx;
	socket;
	request;
	config;
	onClosed;
	runtime;
	provisionalId = randomUUID();
	continuity;
	serverSeq = 0;
	outputSeq = 0;
	outputStreamId = 1;
	outputPtsMs = 0;
	inputStreamId;
	nextInputSequence = 0;
	hello;
	provider;
	session;
	coordinator;
	activeResponseId;
	suppressedResponses = /* @__PURE__ */ new Set();
	handledFunctionCalls = /* @__PURE__ */ new Set();
	latestUserTranscript = "";
	agentWorkPending = false;
	closed = false;
	ready = false;
	leaseAcquired = false;
	helloTimer;
	hostEventsAbort;
	pendingAssistantByTurn = /* @__PURE__ */ new Map();
	constructor(ctx, socket, request, config, onClosed, runtime = new VoiceRuntime()) {
		this.ctx = ctx;
		this.socket = socket;
		this.request = request;
		this.config = config;
		this.onClosed = onClosed;
		this.runtime = runtime;
		this.helloTimer = setTimeout(() => this.fail("hello-timeout", "客户端未及时发送 voice.hello。", false), 1e4);
		socket.on("message", (data, isBinary) => {
			this.receive(data, isBinary).catch((error) => {
				this.fail(this.ready ? "bad-client-message" : "voice-start-failed", error instanceof Error ? error.message : String(error), this.ready);
			});
		});
		socket.once("close", () => this.dispose("client-disconnected"));
		socket.once("error", () => this.dispose("client-error"));
	}
	get id() {
		return this.continuity?.id ?? this.provisionalId;
	}
	dispose(reason = "plugin-disposed") {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.helloTimer);
		this.hostEventsAbort?.abort();
		this.coordinator = void 0;
		this.provider?.close();
		this.provider = void 0;
		if (this.leaseAcquired) {
			this.leaseAcquired = false;
			this.runtime.release(this.provisionalId);
		}
		if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) this.socket.close(1001, reason);
		this.onClosed();
	}
	async receive(raw, isBinary) {
		if (this.closed) return;
		if (this.continuity !== void 0) this.runtime.touch(this.continuity);
		if (isBinary) {
			if (this.provider === void 0) throw new Error("audio arrived before voice.ready");
			const bytes = normalizeRawData(raw);
			if (bytes.byteLength > this.config.maxBinaryFrameBytes) throw new Error("audio frame exceeds the configured limit");
			const frame = decodeAudioFrame(bytes);
			if (frame.kind !== 1) throw new Error("client sent a non-input audio frame");
			if (frame.payload.byteLength === 0 || frame.payload.byteLength % 2 !== 0) throw new Error("PCM input payload must contain complete 16-bit samples");
			if (frame.streamId !== this.inputStreamId) {
				this.inputStreamId = frame.streamId;
				this.nextInputSequence = frame.sequence;
			}
			if (frame.sequence !== this.nextInputSequence) {
				if (frame.sequence < this.nextInputSequence) return;
				throw new Error(`input audio sequence gap: expected ${this.nextInputSequence}, received ${frame.sequence}`);
			}
			this.nextInputSequence += 1;
			this.provider.appendAudio(frame.payload);
			return;
		}
		const parsed = JSON.parse(raw.toString());
		if (!isVoiceClientControl(parsed)) throw new Error("unknown voice control message");
		switch (parsed.type) {
			case "voice.hello":
				if (this.hello !== void 0) throw new Error("voice.hello may only be sent once");
				await this.start(parsed);
				return;
			case "voice.end":
				this.send({
					type: "voice.ended",
					serverSeq: this.nextSeq(),
					reason: parsed.reason ?? "client-ended"
				});
				this.dispose("client-ended");
				return;
			case "voice.cancel-response":
				this.interruptActiveResponse("cancelled", true);
				return;
			case "voice.commit":
				this.provider?.commitAudio();
				return;
			case "voice.approval-answer":
				await this.answerApproval(parsed.approvalId, parsed.outcome);
				return;
			case "voice.question-answer":
				await this.answerQuestion(parsed.requestId, parsed.answers);
				return;
			case "voice.ping":
				if (this.continuity !== void 0) this.runtime.touch(this.continuity);
				this.send({
					type: "voice.pong",
					serverSeq: this.nextSeq(),
					sentAt: parsed.sentAt
				});
				return;
		}
	}
	async start(hello) {
		validateAudioNegotiation(hello);
		clearTimeout(this.helloTimer);
		this.hello = hello;
		const lease = this.runtime.acquireLease({
			connectionId: this.provisionalId,
			platform: hello.client.platform,
			clientVersion: hello.client.version,
			sessionId: hello.target.sessionId,
			...hello.resume === void 0 ? {} : { resumeId: hello.resume.voiceSessionId },
			revoke: () => this.dispose("voice-resumed-elsewhere")
		});
		if (!lease.ok) {
			this.send({
				type: "voice.busy",
				serverSeq: this.nextSeq(),
				occupancy: lease.occupancy
			});
			this.dispose("voice-busy");
			return;
		}
		this.leaseAcquired = true;
		this.continuity = lease.state;
		this.session = new DshVoiceSession(this.ctx, hello.target.sessionId);
		const status = await this.session.snapshot();
		const coordinator = new DshVoiceCoordinator(this.ctx, hello.target.sessionId, this.continuity.coordinator);
		this.coordinator = coordinator;
		const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv));
		if (credential === void 0) {
			this.fail("credential-missing", `未检测到 ${this.config.apiKeyEnv}。请打开“设置 → 插件 → DSH 实时语音”安全保存百炼 API Key，或在本机环境中配置同名变量。`, false);
			return;
		}
		const instructions = buildInstructions(status, this.continuity);
		const provider = new DashScopeRealtime(this.config, credential.value, instructions, REALTIME_FUNCTION_TOOLS, { onEvent: (event) => this.onProviderEvent(event) });
		this.provider = provider;
		await provider.connect();
		if (this.closed) return;
		this.ready = true;
		this.send({
			type: "voice.ready",
			protocol: VOICE_PROTOCOL,
			voiceSessionId: this.id,
			serverSeq: this.nextSeq(),
			target: {
				sessionId: hello.target.sessionId,
				running: status.running
			},
			provider: {
				id: "dashscope",
				model: this.config.model,
				voice: this.config.voice,
				turnDetection: this.config.turnDetection
			},
			audio: {
				input: {
					encoding: "pcm_s16le",
					sampleRate: INPUT_SAMPLE_RATE,
					channels: 1,
					frameDurationMs: 40
				},
				output: {
					encoding: "pcm_s16le",
					sampleRate: OUTPUT_SAMPLE_RATE,
					channels: 1,
					frameDurationMs: 40
				},
				maxBinaryFrameBytes: this.config.maxBinaryFrameBytes
			},
			capabilities: {
				bargeIn: true,
				functionCalling: true,
				reconnect: true,
				persistentAgentTask: true
			}
		});
		this.sendState("listening");
		if (this.continuity.pendingApproval !== void 0) this.sendApproval(this.continuity.pendingApproval, "pending");
		if (this.continuity.pendingQuestion !== void 0) this.sendQuestion(this.continuity.pendingQuestion, "pending");
		this.followDshEvents(hello.target.sessionId);
	}
	onProviderEvent(event) {
		if (this.closed) return;
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				this.interruptActiveResponse("barge-in", false);
				this.sendState("listening");
				return;
			case "input_audio_buffer.speech_stopped":
				this.sendState("thinking");
				return;
			case "conversation.item.input_audio_transcription.delta":
				this.sendTranscript("user", false, field(event, "text"), optionalField(event, "stash"));
				return;
			case "conversation.item.input_audio_transcription.completed": {
				const transcript = field(event, "transcript");
				this.latestUserTranscript = transcript.trim();
				if (this.continuity !== void 0) {
					this.continuity.userTranscript = transcript.trim();
					this.runtime.touch(this.continuity);
				}
				this.sendTranscript("user", true, transcript);
				return;
			}
			case "response.created": {
				const response = event.response;
				this.activeResponseId = typeof response?.id === "string" ? response.id : void 0;
				this.sendState("thinking");
				return;
			}
			case "response.function_call_arguments.done":
				this.handleFunctionCall(event);
				return;
			case "response.audio.delta": {
				const effectiveResponseId = optionalField(event, "response_id") ?? this.activeResponseId;
				if (effectiveResponseId !== void 0 && this.suppressedResponses.has(effectiveResponseId)) return;
				const audio = Buffer.from(field(event, "delta"), "base64");
				const sequence = this.outputSeq++;
				const frame = encodeAudioFrame(2, this.outputStreamId, sequence, audio, { ptsMs: Math.round(this.outputPtsMs) });
				this.outputPtsMs += audio.byteLength / 2 / OUTPUT_SAMPLE_RATE * 1e3;
				if (this.socket.readyState !== this.socket.OPEN) return;
				this.socket.send(frame, { binary: true }, (error) => {
					if (isWebSocketSendError(error) && !this.closed) this.dispose("browser-audio-send-failed");
				});
				this.sendState("speaking");
				return;
			}
			case "response.audio_transcript.delta":
				this.sendTranscript("assistant", false, field(event, "delta"));
				return;
			case "response.audio_transcript.done":
				if (this.continuity !== void 0) {
					this.continuity.assistantTranscript = field(event, "transcript").trim();
					this.runtime.touch(this.continuity);
				}
				this.sendTranscript("assistant", true, field(event, "transcript"));
				return;
			case "response.done": {
				const response = event.response;
				const responseId = typeof response?.id === "string" ? response.id : void 0;
				if (responseId !== void 0) this.suppressedResponses.delete(responseId);
				this.activeResponseId = void 0;
				this.sendState(this.agentWorkPending ? "agent-working" : "listening");
				return;
			}
			case "transport.closed":
				this.ctx.logger.warn(`[realtime-voice] DashScope closed: code=${String(event.code)} reason=${String(event.reason ?? "")}`);
				this.fail("provider-disconnected", `百炼实时语音连接已断开（代码 ${String(event.code)}${event.reason === "" ? "" : `：${String(event.reason)}`}）。`, true);
				this.dispose("provider-disconnected");
				return;
			case "error": {
				const error = event.error;
				const message = typeof error?.message === "string" ? error.message : "百炼实时语音服务返回错误。";
				if (/no active response/i.test(message) && this.suppressedResponses.size > 0) return;
				this.ctx.logger.warn(`[realtime-voice] provider error: ${message}`);
				this.fail("provider-error", message, true);
				return;
			}
		}
	}
	/** Execute only the small semantic bridge vocabulary exposed to Qwen. */
	async handleFunctionCall(event) {
		const callId = field(event, "call_id");
		const name = field(event, "name");
		if (callId === "" || name === "" || this.handledFunctionCalls.has(callId) || this.closed) return;
		this.handledFunctionCalls.add(callId);
		this.send({
			type: "voice.tool",
			serverSeq: this.nextSeq(),
			callId,
			name,
			status: "started"
		});
		try {
			const args = parseArguments(field(event, "arguments"));
			let output;
			switch (name) {
				case "handoff_to_dsh_agent": {
					const instruction = requiredString(args, "instruction");
					const handoff = await this.coordinator.handoff(instruction, this.latestUserTranscript);
					this.agentWorkPending = true;
					this.sendState("agent-working");
					this.send({
						type: "voice.agent-status",
						serverSeq: this.nextSeq(),
						sessionId: handoff.sessionId,
						running: true,
						summary: handoff.mode === "steer" ? "已将补充要求加入正在运行的任务" : "DSH Agent 已开始执行"
					});
					output = {
						status: "accepted",
						handoff_id: handoff.handoffId,
						target_session_id: handoff.sessionId,
						mode: handoff.mode
					};
					break;
				}
				case "cancel_dsh_agent":
					output = await this.coordinator.cancel(optionalString(args, "reason") ?? "");
					this.agentWorkPending = false;
					break;
				case "answer_dsh_approval": {
					const decision = requiredString(args, "decision");
					if (decision !== "allowed-once" && decision !== "rejected") throw new Error("approval decision must be allowed-once or rejected");
					output = await this.coordinator.resolveApproval(requiredString(args, "approval_id"), decision);
					break;
				}
				case "answer_dsh_question":
					output = await this.coordinator.answerQuestion(requiredString(args, "request_id"), parseQuestionAnswers(args.answers));
					break;
				default: throw new Error(`Unknown realtime bridge tool: ${name}`);
			}
			this.provider?.completeFunctionCall(callId, output);
			this.send({
				type: "voice.tool",
				serverSeq: this.nextSeq(),
				callId,
				name,
				status: "completed",
				message: "DSH 已受理。"
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.provider?.completeFunctionCall(callId, {
				status: "failed",
				error: message
			});
			this.send({
				type: "voice.tool",
				serverSeq: this.nextSeq(),
				callId,
				name,
				status: "failed",
				message
			});
			this.sendState(this.agentWorkPending ? "agent-working" : "listening");
		}
	}
	followDshEvents(sessionId) {
		const abort = new AbortController();
		this.hostEventsAbort = abort;
		const request = {
			rpcId: this.rpcId(),
			payload: {}
		};
		(async () => {
			for await (const item of this.ctx.apiProxy.events.host(request, abort.signal)) {
				const frame = item.payload;
				if (frame.type === "host/session-status" && frame.sessionId === sessionId) {
					this.agentWorkPending = frame.running || this.coordinator?.active === true;
					this.send({
						type: "voice.agent-status",
						serverSeq: this.nextSeq(),
						sessionId: frame.sessionId,
						running: frame.running
					});
					continue;
				}
				if (frame.type === "host/agent-error" && frame.sessionId === sessionId) {
					this.agentWorkPending = false;
					this.send({
						type: "voice.agent-status",
						serverSeq: this.nextSeq(),
						sessionId,
						running: false,
						summary: "DSH Agent 运行失败。"
					});
					this.provider?.announceBackendEvent(`backend_agent_error_${this.nextSeq()}`, "[FAILED] DSH Agent 运行失败。请如实告诉用户任务没有完成，并建议查看绑定任务中的错误详情。");
				}
			}
		})().catch((error) => {
			if (!abort.signal.aborted) this.ctx.logger.warn(error);
		});
		const muxRequest = {
			rpcId: this.rpcId(),
			payload: {}
		};
		(async () => {
			for await (const item of this.ctx.apiProxy.events.mux(muxRequest, abort.signal)) {
				const frame = item.payload;
				if (!("sessionId" in frame) || frame.sessionId !== sessionId) continue;
				if (frame.type === "approval/requested") {
					const approval = {
						rpcId: item.rpcId,
						approvalId: frame.approvalId,
						sessionId: frame.sessionId,
						toolName: frame.toolName,
						...frame.callId === void 0 ? {} : { callId: frame.callId },
						...frame.reason === void 0 ? {} : { reason: frame.reason }
					};
					this.coordinator?.rememberApproval(approval);
					this.agentWorkPending = true;
					this.sendApproval(approval, "pending");
					this.provider?.announceBackendEvent(`backend_approval_${frame.approvalId}`, `[NEEDS_APPROVAL] DSH 正在等待用户批准。approval_id=${frame.approvalId}；工具=${frame.toolName}；原因=${frame.reason ?? "未提供"}。请简短说明风险并询问用户是否允许一次。用户明确同意或拒绝后，必须调用 answer_dsh_approval；不要把回答当成新任务。`);
					continue;
				}
				if (frame.type === "approval/resolved") {
					const existing = this.coordinator?.listPendingApprovals().find((value) => value.approvalId === frame.approvalId);
					this.coordinator?.forgetApproval(frame.approvalId);
					if (existing !== void 0) this.sendApproval(existing, "resolved", frame.outcome);
					continue;
				}
				if (frame.type === "question/requested") {
					const question = {
						rpcId: item.rpcId,
						sessionId: frame.sessionId,
						questions: frame.questions.map((value) => ({
							id: value.id,
							question: value.question,
							...value.detail === void 0 ? {} : { detail: value.detail },
							...value.header === void 0 ? {} : { header: value.header },
							...value.options === void 0 ? {} : { options: value.options.map((option) => ({ ...option })) },
							...value.multiSelect === void 0 ? {} : { multiSelect: value.multiSelect }
						}))
					};
					this.coordinator?.rememberQuestion(question);
					this.agentWorkPending = true;
					this.sendQuestion(question, "pending");
					this.provider?.announceBackendEvent(`backend_question_${item.rpcId}`, `[NEEDS_INPUT] DSH Agent 需要用户作决定。request_id=${item.rpcId}。问题：${formatQuestions(question)}。请自然地询问用户；得到明确答案后调用 answer_dsh_question，不要把答案当作新任务。`);
					continue;
				}
				if (frame.type === "question/resolved") {
					const existing = this.coordinator?.listPendingQuestions().find((value) => value.rpcId === frame.questionRpcId);
					this.coordinator?.forgetQuestion(frame.questionRpcId);
					if (existing !== void 0) this.sendQuestion(existing, "resolved", frame.outcome);
					continue;
				}
				if (frame.type === "session/jobs") {
					const active = frame.jobs.filter((job) => job.status === "running" || job.status === "stopping");
					if (active.length > 0) {
						this.agentWorkPending = true;
						this.send({
							type: "voice.agent-status",
							serverSeq: this.nextSeq(),
							sessionId,
							running: true,
							summary: active.map((job) => job.label).join("、").slice(0, 1200)
						});
					}
					continue;
				}
				if (frame.type !== "session/event") continue;
				const event = frame.event;
				if (event.type === "turn/start") {
					const data = event.data;
					if (typeof data.turn === "number") this.coordinator?.markTurnStarted(data.turn);
					this.agentWorkPending = true;
					this.sendState("agent-working");
					continue;
				}
				if (event.type === "assistant/message") {
					const turn = event.data.turn;
					const text = assistantText(event);
					if (typeof turn === "number" && text !== void 0) {
						this.pendingAssistantByTurn.set(`${frame.sessionId}:${turn}`, text);
						this.send({
							type: "voice.agent-status",
							serverSeq: this.nextSeq(),
							sessionId,
							running: true,
							summary: text.slice(0, 1200)
						});
						this.provider?.announceBackendEvent(`backend_progress_${event.seq}`, `[STATUS] ${text}\n这是执行中的阶段更新。只在它对当前对话有帮助时简短播报，不要把它误当成最终完成。`);
					}
					continue;
				}
				if (event.type === "tool/call") {
					const data = event.data;
					const name = typeof data.name === "string" ? data.name : "工具";
					this.send({
						type: "voice.agent-status",
						serverSeq: this.nextSeq(),
						sessionId,
						running: true,
						summary: `正在使用 ${name}`
					});
					continue;
				}
				if (event.type !== "turn/end") continue;
				const data = event.data;
				const turn = data.turn;
				if (typeof turn !== "number") continue;
				const key = `${frame.sessionId}:${turn}`;
				const text = this.pendingAssistantByTurn.get(key);
				this.pendingAssistantByTurn.delete(key);
				const reason = turnEndKind(data.reason);
				this.coordinator?.markTurnEnded(turn, reason);
				this.agentWorkPending = false;
				this.send({
					type: "voice.agent-status",
					serverSeq: this.nextSeq(),
					sessionId,
					running: false,
					...text === void 0 ? {} : { summary: text.slice(0, 1200) }
				});
				const resultText = text ?? `DSH Agent 已结束本轮工作，结束状态为 ${reason}。`;
				const completionTag = reason === "completed" ? "[COMPLETE]" : reason === "cancelled" ? "[CANCELLED]" : "[FAILED]";
				this.provider?.announceBackendEvent(`backend_complete_${event.seq}`, `${completionTag} ${resultText}\n这是绑定 DSH 任务的权威终态。请简短、准确地向用户汇报；不要再次提交已经完成的任务。`);
			}
		})().catch((error) => {
			if (!abort.signal.aborted) this.ctx.logger.warn(error);
		});
	}
	async answerApproval(approvalId, outcome) {
		const pending = this.coordinator?.listPendingApprovals().find((value) => value.approvalId === approvalId);
		if (pending === void 0) throw new Error(`DSH approval is no longer pending: ${approvalId}`);
		await this.coordinator.resolveApproval(approvalId, outcome);
		this.coordinator.forgetApproval(approvalId);
		this.sendApproval(pending, "resolved", outcome);
		this.provider?.announceBackendEvent(`backend_approval_answer_${approvalId}_${outcome}`, `[STATUS] 用户已${outcome === "allowed-once" ? "允许本次操作" : "拒绝本次操作"}，DSH Agent 将继续处理。无需再次询问。`);
	}
	async answerQuestion(requestId, answers) {
		const pending = this.coordinator?.listPendingQuestions().find((value) => value.rpcId === requestId);
		if (pending === void 0) throw new Error(`DSH question is no longer pending: ${requestId}`);
		await this.coordinator.answerQuestion(requestId, answers);
		this.coordinator.forgetQuestion(requestId);
		this.sendQuestion(pending, "resolved", "answered");
		this.provider?.announceBackendEvent(`backend_question_answer_${requestId}`, "[STATUS] 用户的补充答案已经送回 DSH Agent，任务将继续。无需重复提问。");
	}
	sendApproval(approval, status, outcome) {
		if (this.continuity !== void 0) {
			if (status === "pending") this.continuity.pendingApproval = approval;
			else delete this.continuity.pendingApproval;
			this.runtime.touch(this.continuity);
		}
		this.send({
			type: "voice.approval",
			serverSeq: this.nextSeq(),
			sessionId: approval.sessionId,
			status,
			approval: {
				approvalId: approval.approvalId,
				toolName: approval.toolName,
				...approval.callId === void 0 ? {} : { callId: approval.callId },
				...approval.reason === void 0 ? {} : { reason: approval.reason }
			},
			...outcome === void 0 ? {} : { outcome }
		});
	}
	sendQuestion(question, status, outcome) {
		if (this.continuity !== void 0) {
			if (status === "pending") this.continuity.pendingQuestion = question;
			else delete this.continuity.pendingQuestion;
			this.runtime.touch(this.continuity);
		}
		this.send({
			type: "voice.question",
			serverSeq: this.nextSeq(),
			sessionId: question.sessionId,
			status,
			question: {
				requestId: question.rpcId,
				questions: question.questions.map((value) => ({
					...value,
					...value.options === void 0 ? {} : { options: value.options.map((option) => ({ ...option })) }
				}))
			},
			...outcome === void 0 ? {} : { outcome }
		});
	}
	clearPlayback(reason) {
		this.outputStreamId += 1;
		this.outputSeq = 0;
		this.outputPtsMs = 0;
		this.send({
			type: "voice.playback-clear",
			serverSeq: this.nextSeq(),
			streamId: this.outputStreamId,
			reason
		});
	}
	/** Stop one response exactly once, even when local and provider VAD race. */
	interruptActiveResponse(reason, cancelProvider) {
		const responseId = this.activeResponseId;
		if (responseId !== void 0) {
			if (this.suppressedResponses.has(responseId)) return;
			this.suppressedResponses.add(responseId);
		}
		this.clearPlayback(reason);
		if (responseId === void 0 || !cancelProvider) return;
		try {
			this.provider?.cancelResponse();
		} catch (error) {
			this.ctx.logger.warn(`[realtime-voice] response cancellation raced with transport close: ${String(error)}`);
		}
	}
	sendTranscript(role, final, text, stash) {
		this.send({
			type: "voice.transcript",
			serverSeq: this.nextSeq(),
			role,
			final,
			text,
			...stash === void 0 ? {} : { stash }
		});
	}
	sendState(phase) {
		this.send({
			type: "voice.state",
			serverSeq: this.nextSeq(),
			phase
		});
	}
	fail(code, message, recoverable) {
		this.send({
			type: "voice.error",
			serverSeq: this.nextSeq(),
			code,
			message,
			recoverable
		});
		if (!recoverable) this.dispose(code);
	}
	send(message) {
		if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
		this.socket.send(JSON.stringify(message));
	}
	nextSeq() {
		this.serverSeq += 1;
		return this.serverSeq;
	}
	rpcId() {
		return RpcId(randomUUID());
	}
};
function validateAudioNegotiation(hello) {
	if (hello.audio.input.encoding !== "pcm_s16le" || hello.audio.input.sampleRate !== 16e3 || hello.audio.input.channels !== 1) throw new Error("V1 input requires PCM s16le, 16 kHz, mono");
	if (hello.audio.output.encoding !== "pcm_s16le" || hello.audio.output.sampleRate !== 24e3 || hello.audio.output.channels !== 1) throw new Error("V1 output requires PCM s16le, 24 kHz, mono");
}
function normalizeRawData(raw) {
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
	return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}
function buildInstructions(status, continuity) {
	return [
		"你是 DeepSeek Harness 中一个统一助手的实时语音界面。你的首要目标是像自然通话一样快速、简洁地回应，并保持可随时打断。",
		"你负责低延迟交谈；绑定的 DSH Agent 负责真正执行任务。两者是同一个助手的对话面和执行面，不要向用户讲“后端”“工具路由”或内部实现。",
		"普通寒暄、解释、简单问答以及只依赖当前对话即可回答的内容，由你立即回答，不调用工具。",
		"凡是用户要求读取或修改文件、操作应用或设备、运行命令、写代码、查询绑定任务、使用项目上下文、联网研究、打印、发送，或任何需要真实执行和验证的工作，必须调用 handoff_to_dsh_agent。不要只教用户手动操作，也不要声称自己无法访问；让 DSH Agent 先实际尝试。",
		"handoff_to_dsh_agent 返回 accepted 只代表已受理，绝不代表完成。你可以立即自然确认“我来处理”，保持对话可继续；只有 [BACKEND][COMPLETE] 才能说任务已经完成。",
		"DSH 工作期间，用户的新约束、纠正或补充仍调用 handoff_to_dsh_agent；宿主会自动把它 steer 进同一正在执行的任务。用户要求停止时调用 cancel_dsh_agent。",
		"收到 [BACKEND][STATUS] 时，只在有帮助时用一句话播报进展；它不是终态。收到 [BACKEND][COMPLETE]、[FAILED] 或 [CANCELLED] 时，如实、简短播报权威结果，且不要重新提交已经结束的工作。",
		"收到 [BACKEND][NEEDS_APPROVAL] 时，简短说明要做的操作和风险并询问用户；得到明确同意或拒绝后调用 answer_dsh_approval。收到 [BACKEND][NEEDS_INPUT] 时自然提问，得到答案后调用 answer_dsh_question。此类回答不是新任务。",
		"如果一句话既包含可立即回答的问题又包含要执行的任务，可以先简短回答，再调用 handoff_to_dsh_agent；不要为了调用工具而长时间沉默。",
		`当前 DSH 状态：running=${String(status.running)}, blank=${String(status.blank)}.`,
		status.cwd === void 0 ? "" : `当前项目目录：${status.cwd}.`,
		status.title === void 0 ? "" : `当前会话标题：${status.title}.`,
		status.summary === void 0 ? "当前没有可用的最近 Agent 摘要。" : `最近 Agent 内容：${status.summary}`,
		continuity?.userTranscript === "" || continuity?.userTranscript === void 0 ? "" : `断线前用户最后一句：${continuity.userTranscript}`,
		continuity?.assistantTranscript === "" || continuity?.assistantTranscript === void 0 ? "" : `断线前你最后一句：${continuity.assistantTranscript}`
	].filter(Boolean).join("\n");
}
function field(value, name) {
	const result = value[name];
	return typeof result === "string" ? result : "";
}
function optionalField(value, name) {
	const result = value[name];
	return typeof result === "string" ? result : void 0;
}
const REALTIME_FUNCTION_TOOLS = [
	{
		type: "function",
		function: {
			name: "handoff_to_dsh_agent",
			description: "把需要真实执行、访问 DSH 会话/项目/文件/应用/设备/网络或持续 Agent 工作的用户意图交给绑定的 DSH Agent。若 Agent 正在运行，调用会成为同一任务的实时纠正或补充。",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["instruction"],
				properties: { instruction: {
					type: "string",
					description: "完整、可执行的用户要求，保留对象、约束、格式和验收条件；不要添加用户没有说过的事实。"
				} }
			}
		}
	},
	{
		type: "function",
		function: {
			name: "cancel_dsh_agent",
			description: "当用户明确要求停止或取消当前绑定的 DSH Agent 工作时调用。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { reason: {
					type: "string",
					description: "用户要求取消的原因，可省略。"
				} }
			}
		}
	},
	{
		type: "function",
		function: {
			name: "answer_dsh_approval",
			description: "回答 DSH Agent 正在等待的操作审批。仅在用户已经明确同意或拒绝后调用。",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["approval_id", "decision"],
				properties: {
					approval_id: { type: "string" },
					decision: {
						type: "string",
						enum: ["allowed-once", "rejected"]
					}
				}
			}
		}
	},
	{
		type: "function",
		function: {
			name: "answer_dsh_question",
			description: "把用户对 DSH Agent 结构化追问的答案送回原请求。仅用于当前 [NEEDS_INPUT]。",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["request_id", "answers"],
				properties: {
					request_id: { type: "string" },
					answers: {
						type: "array",
						minItems: 1,
						maxItems: 3,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["id", "selected"],
							properties: {
								id: { type: "string" },
								selected: {
									type: "array",
									items: { type: "string" }
								},
								custom: { type: "string" }
							}
						}
					}
				}
			}
		}
	}
];
function parseArguments(value) {
	if (value.trim() === "") return {};
	const parsed = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Realtime function arguments must be a JSON object");
	return parsed;
}
function requiredString(value, name) {
	const result = optionalString(value, name);
	if (result === void 0 || result === "") throw new Error(`Missing realtime function argument: ${name}`);
	return result;
}
function optionalString(value, name) {
	const result = value[name];
	return typeof result === "string" ? result.trim() : void 0;
}
function parseQuestionAnswers(value) {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Question answers must be a non-empty array");
	return value.map((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Invalid question answer");
		const answer = item;
		const id = requiredString(answer, "id");
		if (!Array.isArray(answer.selected) || !answer.selected.every((option) => typeof option === "string")) throw new Error(`Question answer ${id} has invalid selected options`);
		const custom = optionalString(answer, "custom");
		return {
			id,
			selected: answer.selected.map((option) => option.trim()),
			...custom === void 0 ? {} : { custom }
		};
	});
}
function formatQuestions(value) {
	return value.questions.map((question) => {
		const options = question.options?.map((option) => option.label).join("、");
		return `${question.id}: ${question.question}${options === void 0 || options === "" ? "" : `（选项：${options}）`}`;
	}).join("；");
}
function turnEndKind(value) {
	const kind = typeof value === "string" ? value : typeof value === "object" && value !== null && typeof value.kind === "string" ? value.kind : "completed";
	if (kind === "aborted" || kind === "interrupted" || kind === "cancelled") return "cancelled";
	if (kind === "error" || kind === "blocked" || kind === "max-tokens" || kind === "failed") return "failed";
	return "completed";
}
//#endregion
//#region src/index.ts
/** Host services required before the route can be mounted. */
const inject = [
	"webServer",
	"apiProxy",
	"credentials",
	"agents",
	"systemPrompt",
	"tools"
];
/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
function apply(ctx, config) {
	const server = new WebSocketServer({ noServer: true });
	const connections = /* @__PURE__ */ new Set();
	const voiceRuntime = new VoiceRuntime();
	let readConfig = () => config;
	installSettingsSection(ctx, settingsNamespace(REALTIME_VOICE_SETTINGS_NAMESPACE), Config, config, {
		setSource(source) {
			readConfig = source;
		},
		onChange() {}
	});
	const upgrade = (request, socket, head) => {
		const activeConfig = readConfig();
		if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (connections.size >= activeConfig.maxConnections) {
			socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		server.handleUpgrade(request, socket, head, (websocket) => {
			let connection;
			connection = new VoiceConnection(ctx, websocket, request, activeConfig, () => connections.delete(connection), voiceRuntime);
			connections.add(connection);
		});
	};
	const status = (request, response) => {
		if (request.method !== "GET") {
			response.writeHead(405, { Allow: "GET" });
			response.end();
			return;
		}
		if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
			response.writeHead(403);
			response.end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store"
		});
		response.end(JSON.stringify(voiceRuntime.occupancy()));
	};
	ctx.effect(() => {
		const unregisterStatus = ctx.webServer.register({
			kind: "exact",
			path: VOICE_STATUS_ROUTE,
			handler: status
		});
		const unregister = ctx.webServer.registerUpgrade({
			path: VOICE_ROUTE,
			handler: upgrade
		});
		return async () => {
			unregister();
			unregisterStatus();
			for (const connection of [...connections]) connection.dispose();
			connections.clear();
			voiceRuntime.clear();
			await new Promise((resolve) => server.close(() => resolve()));
		};
	}, "realtime-voice: route and active call lifecycle");
}
function isLoopback(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function isAllowedOrigin(request) {
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	const host = request.headers.host;
	if (host === void 0) return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
	} catch {
		return false;
	}
}
//#endregion
export { Config, apply, inject };

//# sourceMappingURL=index.js.map