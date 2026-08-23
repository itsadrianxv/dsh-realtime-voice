import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL, VOICE_ROUTE, decodeAudioFrame, encodeAudioFrame, isVoiceClientControl } from "./protocol.js";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import WebSocket, { WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
/** One upstream Qwen-Audio Realtime session used only for speech I/O. */
var DashScopeRealtime = class {
	config;
	apiKey;
	instructions;
	callbacks;
	socketFactory;
	socket;
	queuedAnnouncements = [];
	announcedIds = /* @__PURE__ */ new Set();
	responseActive = false;
	responseRequested = false;
	inputSpeechActive = false;
	closed = false;
	constructor(config, apiKey, instructions, callbacks, socketFactory = (url, options) => new WebSocket(url, options)) {
		this.config = config;
		this.apiKey = apiKey;
		this.instructions = instructions;
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
	/** Feed a completed durable DSH turn back into the short-lived voice context and speak it once. */
	announceAgentResult(text, eventSeq) {
		const id = `dsh_agent_${eventSeq}`;
		this.queueAnnouncement(id, `DSH Agent 刚完成了一次工作。以下是 DSH 会话中的权威最终回复。请用自然、简短的中文主动向用户播报结果，不要重复提交任务：\n${text.slice(0, 2e3)}`);
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
				role: "system",
				content: [{
					type: "input_text",
					text: announcement.text
				}]
			}
		});
		this.requestResponse();
	}
	requestResponse() {
		this.responseRequested = true;
		this.send({ type: "response.create" });
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
const VOICE_COORDINATOR_PROMPT = `## Realtime voice coordinator

This DSH session is currently the reasoning coordinator for a live voice call. Preserve the session's original instructions, permissions, memory, project context, and ongoing work. The speech provider is only the ears and voice; you are the Agent that decides, answers, and acts.

Keep spoken answers concise and natural. Choose one of three modes:

1. Converse here for discussion, clarification, prioritization, and ordinary questions.
2. Do a quick check here when it is short and immediately helps the live conversation.
3. Delegate blocking mechanics with voice_delegate_task when work is slow, multi-step, or can proceed independently, especially file or app operations, printing, browsing, implementation, deep investigation, log collection, deployment, and device or external-service actions. Keep this coordinator responsive while the worker runs.

For follow-up instructions to a delegated worker, use voice_message_task. Use voice_task_status to inspect it and voice_cancel_task only when the user clearly asks to stop that worker. Worker results will be returned to this coordinator automatically.

Never claim that you cannot access the computer, files, apps, or devices before the appropriate worker has inspected the available DSH tools and permissions. Preserve every concrete constraint in the delegated instruction. For example, a request to find a WeChat document and print it in color, double-sided is blocking mechanics and must be delegated in full, not replaced with manual steps.`;
/**
* Scoped DSH-side coordinator attached only to the Agent session owning one
* voice call. DSH makes every semantic decision; the audio model gets no tools.
*/
var DshVoiceCoordinator = class {
	ctx;
	sessionId;
	callbacks;
	workers = /* @__PURE__ */ new Map();
	disposers = [];
	attached = false;
	constructor(ctx, sessionId, callbacks = {}) {
		this.ctx = ctx;
		this.sessionId = sessionId;
		this.callbacks = callbacks;
	}
	async attach() {
		if (this.attached) return;
		const models = await this.ctx.apiProxy.sessions.models({
			rpcId: this.rpcId(),
			payload: { sessionId: SessionId(this.sessionId) }
		});
		if (!models.result.ok) throw new Error(models.result.error.message);
		const agent = this.ctx.agents.get(SessionId(this.sessionId));
		if (agent === void 0) throw new Error(`DSH Agent is unavailable: ${this.sessionId}`);
		this.disposers.push(agent.ctx.systemPrompt.section({
			name: "realtime-voice:coordinator",
			order: 40,
			text: VOICE_COORDINATOR_PROMPT
		}));
		this.disposers.push(agent.ctx.tools.register(this.delegateTool()));
		this.disposers.push(agent.ctx.tools.register(this.messageTool()));
		this.disposers.push(agent.ctx.tools.register(this.statusTool()));
		this.disposers.push(agent.ctx.tools.register(this.cancelTool()));
		this.attached = true;
	}
	dispose() {
		if (!this.attached) return;
		this.attached = false;
		for (const dispose of this.disposers.splice(0).reverse()) dispose();
	}
	/** Every completed spoken turn enters the authoritative bound DSH session. */
	async submitUserTurn(transcript) {
		const state = await this.sessionState(this.sessionId);
		const response = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(this.sessionId),
				mode: state.running ? "steer" : "queue",
				content: [{
					type: "text",
					text: transcript.trim()
				}]
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
	}
	isWorkerSession(sessionId) {
		return this.workers.has(sessionId);
	}
	/** Return one completed worker turn to the coordinator as durable context. */
	async returnWorkerResult(workerSessionId, text) {
		const worker = this.workers.get(workerSessionId);
		if (worker === void 0) return;
		worker.running = false;
		this.callbacks.onWorkerUpdated?.(worker);
		const response = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(this.sessionId),
				mode: "queue",
				content: [{
					type: "text",
					text: `[Voice worker returned]\nWorker session: ${workerSessionId}\nOriginal delegated request: ${worker.instruction}\nAuthoritative worker result:\n${text.slice(0, 6e3)}\n\nBriefly report the outcome in the live voice conversation. If a user decision is needed, ask exactly that question. Do not repeat or redo completed work.`
				}]
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
	}
	delegateTool() {
		return defineTool({
			name: "voice_delegate_task",
			description: "Create a real background DSH Agent session for slow, multi-step, blocking, or independent work while this live voice coordinator remains responsive.",
			parameters: {
				instruction: {
					type: "string",
					required: true,
					description: "Complete worker instruction preserving every user constraint."
				},
				title: {
					type: "string",
					description: "Short task title shown in DSH."
				}
			},
			output: {
				schema: {
					type: "object",
					properties: {
						sessionId: {
							type: "string",
							required: true
						},
						status: {
							type: "string",
							required: true
						},
						title: {
							type: "string",
							required: true
						}
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: async (args) => this.delegate(args.instruction, args.title)
		});
	}
	messageTool() {
		return defineTool({
			name: "voice_message_task",
			description: "Send a follow-up or correction to a background DSH worker created by this voice call.",
			parameters: {
				sessionId: {
					type: "string",
					required: true,
					description: "Worker session id returned by voice_delegate_task."
				},
				instruction: {
					type: "string",
					required: true,
					description: "Complete follow-up instruction."
				},
				mode: {
					type: "string",
					enum: [
						"auto",
						"queue",
						"steer"
					],
					description: "auto steers a running worker and queues an idle worker."
				}
			},
			output: {
				schema: {
					type: "object",
					properties: {
						sessionId: {
							type: "string",
							required: true
						},
						status: {
							type: "string",
							required: true
						},
						mode: {
							type: "string",
							required: true
						}
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: async (args) => this.messageWorker(args.sessionId, args.instruction, args.mode ?? "auto")
		});
	}
	statusTool() {
		return defineTool({
			name: "voice_task_status",
			description: "Read the authoritative running state and latest reply of a background worker created by this voice call.",
			parameters: { sessionId: {
				type: "string",
				required: true,
				description: "Worker session id returned by voice_delegate_task."
			} },
			output: {
				schema: {
					type: "object",
					properties: {
						sessionId: {
							type: "string",
							required: true
						},
						running: {
							type: "boolean",
							required: true
						},
						title: {
							type: "string",
							required: true
						},
						latestReply: {
							type: "string",
							required: true
						}
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: async (args) => this.workerStatus(args.sessionId)
		});
	}
	cancelTool() {
		return defineTool({
			name: "voice_cancel_task",
			description: "Cancel one background worker only after the user clearly asks to stop that delegated task.",
			parameters: { sessionId: {
				type: "string",
				required: true,
				description: "Worker session id returned by voice_delegate_task."
			} },
			output: {
				schema: {
					type: "object",
					properties: {
						sessionId: {
							type: "string",
							required: true
						},
						status: {
							type: "string",
							required: true
						}
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			execute: async (args) => this.cancelWorker(args.sessionId)
		});
	}
	async delegate(instruction, requestedTitle) {
		const parent = await this.sessionState(this.sessionId);
		const created = await this.ctx.apiProxy.sessions.create({
			rpcId: this.rpcId(),
			payload: parent.cwd === void 0 ? {} : { cwd: parent.cwd }
		});
		if (!created.result.ok) throw new Error(created.result.error.message);
		const workerSessionId = created.result.value.sessionId;
		const title = requestedTitle?.trim() || instruction.trim().slice(0, 48) || "Voice delegated task";
		const models = await this.ctx.apiProxy.sessions.models({
			rpcId: this.rpcId(),
			payload: { sessionId: SessionId(this.sessionId) }
		});
		if (models.result.ok) {
			const current = models.result.value.current;
			const selected = await this.ctx.apiProxy.sessions.selectModel({
				rpcId: this.rpcId(),
				payload: {
					sessionId: SessionId(workerSessionId),
					provider: current.provider,
					model: current.model,
					...current.reasoningEffort === void 0 ? {} : { reasoningEffort: current.reasoningEffort }
				}
			});
			if (!selected.result.ok) throw new Error(selected.result.error.message);
		}
		const renamed = await this.ctx.apiProxy.sessions.rename({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(workerSessionId),
				title
			}
		});
		if (!renamed.result.ok) throw new Error(renamed.result.error.message);
		const worker = {
			sessionId: workerSessionId,
			running: true,
			...parent.cwd === void 0 ? {} : { cwd: parent.cwd },
			title: renamed.result.value.title,
			instruction: instruction.trim()
		};
		this.workers.set(workerSessionId, worker);
		this.callbacks.onWorkerStarted?.(worker);
		const prompted = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(workerSessionId),
				mode: "queue",
				content: [{
					type: "text",
					text: instruction.trim()
				}]
			}
		});
		if (!prompted.result.ok) throw new Error(prompted.result.error.message);
		return {
			sessionId: workerSessionId,
			status: "running",
			title: worker.title ?? title
		};
	}
	async messageWorker(sessionId, instruction, requestedMode) {
		const worker = this.requireWorker(sessionId);
		const state = await this.sessionState(sessionId);
		const mode = requestedMode === "auto" ? state.running ? "steer" : "queue" : requestedMode;
		const response = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(sessionId),
				mode,
				content: [{
					type: "text",
					text: instruction.trim()
				}]
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		worker.running = true;
		this.callbacks.onWorkerUpdated?.(worker);
		return {
			sessionId,
			status: "accepted",
			mode
		};
	}
	async workerStatus(sessionId) {
		const worker = this.requireWorker(sessionId);
		const state = await this.sessionState(sessionId);
		const latestReply = await this.lastAssistantText(sessionId);
		worker.running = state.running;
		this.callbacks.onWorkerUpdated?.(worker);
		return {
			sessionId,
			running: state.running,
			title: state.title ?? worker.title ?? "",
			latestReply: latestReply ?? ""
		};
	}
	async cancelWorker(sessionId) {
		const worker = this.requireWorker(sessionId);
		const response = await this.ctx.apiProxy.sessions.cancel({
			rpcId: this.rpcId(),
			payload: { sessionId: SessionId(sessionId) }
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		worker.running = false;
		this.callbacks.onWorkerUpdated?.(worker);
		return {
			sessionId,
			status: "cancelled"
		};
	}
	requireWorker(sessionId) {
		const worker = this.workers.get(sessionId);
		if (worker === void 0) throw new Error(`voice worker is not owned by this call: ${sessionId}`);
		return worker;
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
	async lastAssistantText(sessionId) {
		const response = await this.ctx.apiProxy.sessions.history({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(sessionId),
				maxMessages: 12
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		for (let index = response.result.value.events.length - 1; index >= 0; index -= 1) {
			const event = response.result.value.events[index]?.event;
			if (typeof event !== "object" || event === null || event.type !== "assistant/message") continue;
			const data = event.data;
			if (typeof data !== "object" || data === null) continue;
			const message = data.message;
			if (typeof message !== "object" || message === null) continue;
			const content = message.content;
			if (!Array.isArray(content)) continue;
			const text = content.map((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n").trim();
			if (text !== "") return text.slice(0, 2e3);
		}
	}
	rpcId() {
		return RpcId(randomUUID());
	}
};
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
//#region src/host/voice-connection.ts
/** One browser or Mini Program call, pinned to one DSH session for its full lifetime. */
var VoiceConnection = class {
	ctx;
	socket;
	request;
	config;
	onClosed;
	id = randomUUID();
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
	providerUserResponses = /* @__PURE__ */ new Set();
	awaitingProviderUserResponse = false;
	agentWorkPending = false;
	closed = false;
	ready = false;
	helloTimer;
	hostEventsAbort;
	pendingAssistantByTurn = /* @__PURE__ */ new Map();
	constructor(ctx, socket, request, config, onClosed) {
		this.ctx = ctx;
		this.socket = socket;
		this.request = request;
		this.config = config;
		this.onClosed = onClosed;
		this.helloTimer = setTimeout(() => this.fail("hello-timeout", "客户端未及时发送 voice.hello。", false), 1e4);
		socket.on("message", (data, isBinary) => {
			this.receive(data, isBinary).catch((error) => {
				this.fail(this.ready ? "bad-client-message" : "voice-start-failed", error instanceof Error ? error.message : String(error), this.ready);
			});
		});
		socket.once("close", () => this.dispose("client-disconnected"));
		socket.once("error", () => this.dispose("client-error"));
	}
	dispose(reason = "plugin-disposed") {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.helloTimer);
		this.hostEventsAbort?.abort();
		this.coordinator?.dispose();
		this.coordinator = void 0;
		this.provider?.close();
		this.provider = void 0;
		if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) this.socket.close(1001, reason);
		this.onClosed();
	}
	async receive(raw, isBinary) {
		if (this.closed) return;
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
			case "voice.ping":
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
		this.session = new DshVoiceSession(this.ctx, hello.target.sessionId);
		const status = await this.session.snapshot();
		const coordinator = new DshVoiceCoordinator(this.ctx, hello.target.sessionId, {
			onWorkerStarted: (worker) => this.send({
				type: "voice.agent-status",
				serverSeq: this.nextSeq(),
				sessionId: worker.sessionId,
				running: true,
				...worker.title === void 0 ? {} : { summary: worker.title }
			}),
			onWorkerUpdated: (worker) => this.send({
				type: "voice.agent-status",
				serverSeq: this.nextSeq(),
				sessionId: worker.sessionId,
				running: worker.running,
				...worker.title === void 0 ? {} : { summary: worker.title }
			})
		});
		await coordinator.attach();
		this.coordinator = coordinator;
		const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv));
		if (credential === void 0) {
			this.fail("credential-missing", `未检测到 ${this.config.apiKeyEnv}。请打开“设置 → 插件 → DSH 实时语音”安全保存百炼 API Key，或在本机环境中配置同名变量。`, false);
			return;
		}
		const instructions = buildInstructions(status);
		const provider = new DashScopeRealtime(this.config, credential.value, instructions, { onEvent: (event) => this.onProviderEvent(event) });
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
				functionCalling: false,
				reconnect: true,
				persistentAgentTask: true
			}
		});
		this.sendState("listening");
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
				this.awaitingProviderUserResponse = true;
				this.sendState("thinking");
				return;
			case "conversation.item.input_audio_transcription.delta":
				this.sendTranscript("user", false, field(event, "text"), optionalField(event, "stash"));
				return;
			case "conversation.item.input_audio_transcription.completed": {
				const transcript = field(event, "transcript");
				this.sendTranscript("user", true, transcript);
				this.submitUserTurn(transcript);
				return;
			}
			case "response.created": {
				const response = event.response;
				this.activeResponseId = typeof response?.id === "string" ? response.id : void 0;
				if (this.activeResponseId !== void 0 && this.awaitingProviderUserResponse) {
					this.awaitingProviderUserResponse = false;
					this.providerUserResponses.add(this.activeResponseId);
				}
				this.sendState("thinking");
				return;
			}
			case "response.audio.delta": {
				const effectiveResponseId = optionalField(event, "response_id") ?? this.activeResponseId;
				if (effectiveResponseId !== void 0 && (this.suppressedResponses.has(effectiveResponseId) || this.providerUserResponses.has(effectiveResponseId))) return;
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
				if (this.providerUserResponses.has(optionalField(event, "response_id") ?? this.activeResponseId ?? "")) return;
				this.sendTranscript("assistant", false, field(event, "delta"));
				return;
			case "response.audio_transcript.done":
				if (this.providerUserResponses.has(optionalField(event, "response_id") ?? this.activeResponseId ?? "")) return;
				this.sendTranscript("assistant", true, field(event, "transcript"));
				return;
			case "response.done": {
				const response = event.response;
				const responseId = typeof response?.id === "string" ? response.id : void 0;
				if (responseId !== void 0) this.suppressedResponses.delete(responseId);
				if (responseId !== void 0) this.providerUserResponses.delete(responseId);
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
	/** Send every semantic voice turn to the bound DSH Agent without intent classification. */
	async submitUserTurn(transcript) {
		const text = transcript.trim();
		if (text === "" || this.closed) return;
		const callId = `voice_turn_${randomUUID()}`;
		this.send({
			type: "voice.tool",
			serverSeq: this.nextSeq(),
			callId,
			name: "send_to_dsh_agent",
			status: "started"
		});
		this.agentWorkPending = true;
		this.sendState("agent-working");
		try {
			await this.coordinator.submitUserTurn(text);
			this.send({
				type: "voice.tool",
				serverSeq: this.nextSeq(),
				callId,
				name: "send_to_dsh_agent",
				status: "completed",
				message: "已进入当前 DSH Agent 会话。"
			});
		} catch (error) {
			this.agentWorkPending = false;
			this.send({
				type: "voice.tool",
				serverSeq: this.nextSeq(),
				callId,
				name: "send_to_dsh_agent",
				status: "failed",
				message: error instanceof Error ? error.message : String(error)
			});
			this.sendState("listening");
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
				if (frame.type === "host/session-status" && (frame.sessionId === sessionId || this.coordinator?.isWorkerSession(frame.sessionId) === true)) this.send({
					type: "voice.agent-status",
					serverSeq: this.nextSeq(),
					sessionId: frame.sessionId,
					running: frame.running
				});
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
				if (frame.type !== "session/event") continue;
				const isBoundSession = frame.sessionId === sessionId;
				const isWorkerSession = this.coordinator?.isWorkerSession(frame.sessionId) === true;
				if (!isBoundSession && !isWorkerSession) continue;
				const event = frame.event;
				if (event.type === "assistant/message") {
					const turn = event.data.turn;
					const text = assistantText(event);
					if (typeof turn === "number" && text !== void 0) this.pendingAssistantByTurn.set(`${frame.sessionId}:${turn}`, text);
					continue;
				}
				if (event.type !== "turn/end") continue;
				const turn = event.data.turn;
				if (typeof turn !== "number") continue;
				const key = `${frame.sessionId}:${turn}`;
				const text = this.pendingAssistantByTurn.get(key);
				this.pendingAssistantByTurn.delete(key);
				if (text === void 0) continue;
				if (isWorkerSession) {
					this.send({
						type: "voice.agent-status",
						serverSeq: this.nextSeq(),
						sessionId: frame.sessionId,
						running: false,
						summary: text.slice(0, 1200)
					});
					this.agentWorkPending = true;
					this.sendState("agent-working");
					this.coordinator?.returnWorkerResult(frame.sessionId, text).catch((error) => {
						if (!abort.signal.aborted) this.ctx.logger.warn(`[realtime-voice] failed to return worker result: ${String(error)}`);
					});
					continue;
				}
				this.agentWorkPending = false;
				this.send({
					type: "voice.agent-status",
					serverSeq: this.nextSeq(),
					sessionId,
					running: false,
					summary: text.slice(0, 1200)
				});
				this.provider?.announceAgentResult(text, event.seq);
			}
		})().catch((error) => {
			if (!abort.signal.aborted) this.ctx.logger.warn(error);
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
function buildInstructions(status) {
	return [
		"你是 DeepSeek Harness 的实时语音输入与播报层，不是负责回答或决策的 Agent。",
		"用户说话时只需忠实完成转写；不要回答、建议、拒绝、调用工具或输出任何语音和文字。用户的完整转写会由宿主直接送入绑定的 DSH Agent 会话。",
		"只有收到标记为“DSH Agent 刚完成”的系统上下文时才输出语音：忠实、简短、自然地播报其中的权威结果，不要添加新的判断，也不要再次提交任务。",
		`当前 DSH 状态：running=${String(status.running)}, blank=${String(status.blank)}.`,
		status.cwd === void 0 ? "" : `当前项目目录：${status.cwd}.`,
		status.title === void 0 ? "" : `当前会话标题：${status.title}.`,
		status.summary === void 0 ? "当前没有可用的最近 Agent 摘要。" : `最近 Agent 内容：${status.summary}`
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
			connection = new VoiceConnection(ctx, websocket, request, activeConfig, () => connections.delete(connection));
			connections.add(connection);
		});
	};
	ctx.effect(() => {
		const unregister = ctx.webServer.registerUpgrade({
			path: VOICE_ROUTE,
			handler: upgrade
		});
		return async () => {
			unregister();
			for (const connection of [...connections]) connection.dispose();
			connections.clear();
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