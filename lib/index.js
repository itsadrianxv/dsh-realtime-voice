import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL, VOICE_ROUTE, decodeAudioFrame, encodeAudioFrame, isVoiceClientControl } from "./protocol.js";
import WebSocket, { WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import { SessionId } from "@deepseek-ai/dsh-session/types";
//#region src/host/config.ts
const Config = z.object({
	endpoint: z.string().default("wss://dashscope.aliyuncs.com/api-ws/v1/realtime"),
	apiKeyEnv: z.string().default("DASHSCOPE_API_KEY"),
	model: z.string().default("qwen-audio-3.0-realtime-plus"),
	voice: z.string().default("longanqian"),
	turnDetection: z.union(["server_vad", "smart_turn"]).default("smart_turn"),
	silenceDurationMs: z.natural().min(200).max(6e3).default(600),
	maxHistoryTurns: z.natural().min(1).max(50).default(20),
	maxConnections: z.natural().min(1).max(32).default(4),
	maxBinaryFrameBytes: z.natural().min(1024).max(1048576).default(65536),
	connectTimeoutMs: z.natural().min(1e3).max(6e4).default(15e3)
});
//#endregion
//#region src/host/dashscope-realtime.ts
const TOOL_DEFINITIONS = [
	{
		type: "function",
		function: {
			name: "start_task",
			description: "在当前 DeepSeek Harness 会话中开始一个新的 Agent 工作。",
			parameters: {
				type: "object",
				properties: { instruction: {
					type: "string",
					description: "交给编码 Agent 的完整任务要求。"
				} },
				required: ["instruction"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "send_task_message",
			description: "向当前 DSH 任务追加要求；运行中需要立刻改变方向时使用 steer。",
			parameters: {
				type: "object",
				properties: {
					instruction: {
						type: "string",
						description: "要交给编码 Agent 的要求。"
					},
					mode: {
						type: "string",
						enum: [
							"auto",
							"queue",
							"steer"
						],
						description: "默认 auto；steer 立即纠偏，queue 排入下一轮。"
					}
				},
				required: ["instruction"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "get_task_status",
			description: "读取当前 DSH 会话是否运行以及最近的 Agent 结果。",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	},
	{
		type: "function",
		function: {
			name: "list_sessions",
			description: "按标题或工作区关键词检索 DSH 会话。用户提到其他项目、线程或会话时先调用它，再用返回的 sessionId 读取回复。",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "会话标题或主题关键词，例如“做成微信小程序”。"
					},
					workspace: {
						type: "string",
						description: "工作区目录或名称关键词，例如“deepseek-harness”。"
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 10,
						description: "最多返回多少条，默认 5。"
					}
				}
			}
		}
	},
	{
		type: "function",
		function: {
			name: "get_session_latest_reply",
			description: "读取指定 DSH 会话最后一条 Agent 回复；sessionId 必须来自 list_sessions 的结果。",
			parameters: {
				type: "object",
				properties: { sessionId: {
					type: "string",
					description: "准确的 DSH sessionId。"
				} },
				required: ["sessionId"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "cancel_task",
			description: "停止当前 DSH 会话正在执行的 Agent 回合，但保留排队任务。",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	}
];
/** One upstream Qwen-Audio Realtime session with contained Function Calling. */
var DashScopeRealtime = class {
	config;
	apiKey;
	instructions;
	callbacks;
	socketFactory;
	socket;
	pendingTools = /* @__PURE__ */ new Map();
	queuedAgentAnnouncements = [];
	announcedEventSeqs = /* @__PURE__ */ new Set();
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
							tools: TOOL_DEFINITIONS,
							turn_detection: this.config.turnDetection === "server_vad" ? {
								type: "server_vad",
								threshold: .5,
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
		if (this.closed || this.announcedEventSeqs.has(eventSeq)) return;
		this.announcedEventSeqs.add(eventSeq);
		this.queuedAgentAnnouncements.push({
			eventSeq,
			text: text.slice(0, 2e3)
		});
		if (this.queuedAgentAnnouncements.length > 3) this.queuedAgentAnnouncements.shift();
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
		if (event.type === "response.function_call_arguments.done") {
			const responseId = stringField(event, "response_id");
			const call = {
				callId: stringField(event, "call_id"),
				name: stringField(event, "name"),
				arguments: stringField(event, "arguments")
			};
			const pending = this.pendingTools.get(responseId) ?? [];
			pending.push({
				call,
				result: Promise.resolve().then(() => this.callbacks.onTool(call))
			});
			this.pendingTools.set(responseId, pending);
			return;
		}
		if (event.type !== "response.done") return;
		this.responseActive = false;
		this.responseRequested = false;
		const response = event.response;
		const responseId = typeof response?.id === "string" ? response.id : void 0;
		if (responseId === void 0) {
			this.drainAgentAnnouncements();
			return;
		}
		const pending = this.pendingTools.get(responseId);
		if (pending === void 0 || pending.length === 0) {
			this.drainAgentAnnouncements();
			return;
		}
		this.pendingTools.delete(responseId);
		this.responseRequested = true;
		this.finishTools(pending).catch((error) => {
			this.responseRequested = false;
			if (!this.closed) this.emitEvent({
				type: "error",
				error: {
					type: "client_tool_error",
					message: error instanceof Error ? error.message : String(error)
				}
			});
		});
	}
	async finishTools(pending) {
		const resolved = await Promise.all(pending.map(async (item) => ({
			call: item.call,
			result: await item.result
		})));
		if (this.closed) return;
		for (const item of resolved) this.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: item.call.callId,
				output: item.result.output
			}
		});
		this.requestResponse();
	}
	drainAgentAnnouncements() {
		if (this.closed || this.inputSpeechActive || this.responseActive || this.responseRequested || this.queuedAgentAnnouncements.length === 0) return;
		const announcement = this.queuedAgentAnnouncements.shift();
		this.send({
			type: "conversation.item.create",
			item: {
				id: `dsh_agent_${announcement.eventSeq}`,
				type: "message",
				role: "system",
				content: [{
					type: "input_text",
					text: `DSH Agent 刚完成了一次工作。以下是 DSH 会话中的权威最终回复。请用自然、简短的中文主动向用户播报结果，不要重复提交任务：\n${announcement.text}`
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
function stringField(value, field) {
	const result = value[field];
	if (typeof result !== "string") throw new Error(`DashScope event is missing ${field}`);
	return result;
}
//#endregion
//#region src/host/dsh-tools.ts
/** Allowlisted translation from realtime-model Function Calls to official DSH API services. */
var DshVoiceTools = class {
	ctx;
	sessionId;
	completed = /* @__PURE__ */ new Map();
	constructor(ctx, sessionId) {
		this.ctx = ctx;
		this.sessionId = sessionId;
	}
	/** Execute one idempotent allowlisted call. Duplicate call ids share the first result. */
	execute(call) {
		const existing = this.completed.get(call.callId);
		if (existing !== void 0) return existing;
		const operation = this.executeOnce(call).catch((error) => ({
			ok: false,
			output: JSON.stringify({
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			})
		}));
		this.completed.set(call.callId, operation);
		return operation;
	}
	/** Read the current DSH status used both by UI and initial voice context. */
	async status() {
		const item = (await this.sessions()).find((candidate) => candidate.sessionId === this.sessionId);
		if (item === void 0) throw new Error(`DSH session not found: ${this.sessionId}`);
		const summary = await this.lastAssistantText(this.sessionId).catch(() => void 0);
		return {
			sessionId: this.sessionId,
			running: item.running,
			blank: item.blank,
			...item.cwd === void 0 ? {} : { cwd: item.cwd },
			...item.title === void 0 ? {} : { title: item.title },
			...summary === void 0 ? {} : { summary }
		};
	}
	async executeOnce(call) {
		const args = parseObject(call.arguments);
		switch (call.name) {
			case "start_task": {
				const instruction = requiredString(args, "instruction");
				return this.prompt(instruction, "queue");
			}
			case "send_task_message": {
				const instruction = requiredString(args, "instruction");
				const requestedMode = args.mode;
				if (requestedMode !== void 0 && requestedMode !== "auto" && requestedMode !== "queue" && requestedMode !== "steer") throw new Error("mode must be auto, queue, or steer");
				const mode = requestedMode === void 0 || requestedMode === "auto" ? (await this.status()).running ? "steer" : "queue" : requestedMode;
				return this.prompt(instruction, mode);
			}
			case "get_task_status": return {
				ok: true,
				output: JSON.stringify({
					ok: true,
					...await this.status()
				})
			};
			case "list_sessions": {
				const query = optionalString(args, "query");
				const workspace = optionalString(args, "workspace");
				const limit = optionalInteger(args, "limit", 1, 10) ?? 5;
				const sessions = rankSessions(await this.sessions(), query, workspace).slice(0, limit);
				return {
					ok: true,
					output: JSON.stringify({
						ok: true,
						count: sessions.length,
						sessions,
						hint: sessions.length === 0 ? "没有匹配会话；请尝试更短的标题或工作区关键词。" : "读取最后回复时，请把准确 sessionId 传给 get_session_latest_reply。"
					})
				};
			}
			case "get_session_latest_reply": {
				const targetSessionId = requiredString(args, "sessionId");
				const session = (await this.sessions()).find((candidate) => candidate.sessionId === targetSessionId);
				if (session === void 0) throw new Error(`DSH session not found: ${targetSessionId}`);
				const latestAssistantReply = await this.lastAssistantText(targetSessionId);
				return {
					ok: true,
					output: JSON.stringify({
						ok: true,
						session,
						latestAssistantReply: latestAssistantReply ?? null
					})
				};
			}
			case "cancel_task": {
				const response = await this.ctx.apiProxy.sessions.cancel({
					rpcId: this.rpcId(),
					payload: { sessionId: SessionId(this.sessionId) }
				});
				if (!response.result.ok) throw new Error(response.result.error.message);
				return {
					ok: true,
					output: JSON.stringify({
						ok: true,
						accepted: true
					})
				};
			}
			default: throw new Error(`voice tool is not allowed: ${call.name}`);
		}
	}
	async prompt(instruction, mode) {
		const response = await this.ctx.apiProxy.sessions.prompt({
			rpcId: this.rpcId(),
			payload: {
				sessionId: SessionId(this.sessionId),
				mode,
				content: [{
					type: "text",
					text: instruction
				}]
			}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		return {
			ok: true,
			output: JSON.stringify({
				ok: true,
				accepted: true,
				mode
			})
		};
	}
	async sessions() {
		const response = await this.ctx.apiProxy.sessions.list({
			rpcId: this.rpcId(),
			payload: {}
		});
		if (!response.result.ok) throw new Error(response.result.error.message);
		return response.result.value.items.map((item) => {
			const title = projectionTitle(item.projections?.values);
			return {
				sessionId: item.sessionId,
				running: item.running,
				blank: item.blank,
				updatedAt: item.updatedAt,
				current: item.sessionId === this.sessionId,
				...item.cwd === void 0 ? {} : { cwd: item.cwd },
				...title === void 0 ? {} : { title }
			};
		});
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
			const text = assistantText(event);
			if (text !== void 0) return text.slice(0, 1200);
		}
	}
	rpcId() {
		return RpcId(randomUUID());
	}
};
function parseObject(value) {
	const parsed = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("function arguments must be a JSON object");
	return parsed;
}
function requiredString(value, key) {
	const result = value[key];
	if (typeof result !== "string" || result.trim() === "") throw new Error(`${key} must be a non-empty string`);
	return result.trim();
}
function optionalString(value, key) {
	const result = value[key];
	if (result === void 0) return void 0;
	if (typeof result !== "string" || result.trim() === "") throw new Error(`${key} must be a non-empty string`);
	return result.trim();
}
function optionalInteger(value, key, minimum, maximum) {
	const result = value[key];
	if (result === void 0) return void 0;
	if (typeof result !== "number" || !Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
	return result;
}
function projectionTitle(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const title = value.title;
	if (typeof title === "string" && title.trim() !== "") return title.trim();
	if (typeof title !== "object" || title === null) return void 0;
	const nested = title.title;
	return typeof nested === "string" && nested.trim() !== "" ? nested.trim() : void 0;
}
function rankSessions(sessions, query, workspace) {
	const queryKey = normalizeLookup(query);
	const workspaceKey = normalizeLookup(workspace);
	return sessions.map((session) => ({
		session,
		score: sessionScore(session, queryKey, workspaceKey)
	})).filter((candidate) => candidate.score >= 0).sort((left, right) => right.score - left.score || right.session.updatedAt - left.session.updatedAt).map((candidate) => candidate.session);
}
function sessionScore(session, query, workspace) {
	const title = normalizeLookup(session.title) ?? "";
	const cwd = normalizeLookup(session.cwd) ?? "";
	const sessionId = normalizeLookup(session.sessionId) ?? "";
	if (workspace !== void 0 && !cwd.includes(workspace)) return -1;
	let score = session.current ? 2 : 0;
	if (workspace !== void 0) score += 20;
	if (query === void 0) return score;
	if (title === query) return score + 100;
	if (title.includes(query)) return score + 70;
	if (cwd.includes(query)) return score + 30;
	if (sessionId.includes(query)) return score + 10;
	return -1;
}
function normalizeLookup(value) {
	if (value === void 0) return void 0;
	return value.trim().toLocaleLowerCase("zh-CN").replaceAll("/", "\\");
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
	tools;
	activeResponseId;
	suppressedResponses = /* @__PURE__ */ new Set();
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
				this.provider?.cancelResponse();
				this.clearPlayback("cancelled");
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
		this.tools = new DshVoiceTools(this.ctx, hello.target.sessionId);
		const status = await this.tools.status();
		const credential = await this.ctx.credentials.resolve(credentialRef(this.config.apiKeyEnv));
		if (credential === void 0) {
			this.fail("credential-missing", `DSH 凭据 ${this.config.apiKeyEnv} 尚未配置。`, false);
			return;
		}
		const instructions = buildInstructions(status);
		const provider = new DashScopeRealtime(this.config, credential.value, instructions, {
			onEvent: (event) => this.onProviderEvent(event),
			onTool: (call) => this.runTool(call)
		});
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
				voice: this.config.voice
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
		this.followDshEvents(hello.target.sessionId);
	}
	onProviderEvent(event) {
		if (this.closed) return;
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				if (this.activeResponseId !== void 0) this.suppressedResponses.add(this.activeResponseId);
				this.clearPlayback("barge-in");
				this.sendState("listening");
				return;
			case "input_audio_buffer.speech_stopped":
				this.sendState("thinking");
				return;
			case "conversation.item.input_audio_transcription.delta":
				this.sendTranscript("user", false, field(event, "text"), optionalField(event, "stash"));
				return;
			case "conversation.item.input_audio_transcription.completed":
				this.sendTranscript("user", true, field(event, "transcript"));
				return;
			case "response.created": {
				const response = event.response;
				this.activeResponseId = typeof response?.id === "string" ? response.id : void 0;
				this.sendState("thinking");
				return;
			}
			case "response.audio.delta": {
				const responseId = optionalField(event, "response_id");
				if (responseId !== void 0 && this.suppressedResponses.has(responseId)) return;
				const audio = Buffer.from(field(event, "delta"), "base64");
				const sequence = this.outputSeq++;
				const frame = encodeAudioFrame(2, this.outputStreamId, sequence, audio, { ptsMs: Math.round(this.outputPtsMs) });
				this.outputPtsMs += audio.byteLength / 2 / OUTPUT_SAMPLE_RATE * 1e3;
				if (this.socket.readyState !== this.socket.OPEN) return;
				this.socket.send(frame, { binary: true }, (error) => {
					if (error !== void 0 && !this.closed) this.dispose("browser-audio-send-failed");
				});
				this.sendState("speaking");
				return;
			}
			case "response.audio_transcript.delta":
				this.sendTranscript("assistant", false, field(event, "delta"));
				return;
			case "response.audio_transcript.done":
				this.sendTranscript("assistant", true, field(event, "transcript"));
				return;
			case "response.done": {
				const response = event.response;
				const responseId = typeof response?.id === "string" ? response.id : void 0;
				if (responseId !== void 0) this.suppressedResponses.delete(responseId);
				this.activeResponseId = void 0;
				this.sendState("listening");
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
				this.ctx.logger.warn(`[realtime-voice] provider error: ${message}`);
				this.fail("provider-error", message, true);
				return;
			}
		}
	}
	async runTool(call) {
		this.send({
			type: "voice.tool",
			serverSeq: this.nextSeq(),
			callId: call.callId,
			name: call.name,
			status: "started"
		});
		this.sendState("agent-working");
		const result = await this.tools.execute(call);
		this.send({
			type: "voice.tool",
			serverSeq: this.nextSeq(),
			callId: call.callId,
			name: call.name,
			status: result.ok ? "completed" : "failed",
			message: result.ok ? "DSH 已接受操作。" : result.output
		});
		return result;
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
				if (frame.type === "host/session-status" && frame.sessionId === sessionId) this.send({
					type: "voice.agent-status",
					serverSeq: this.nextSeq(),
					sessionId,
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
				if (frame.type !== "session/event" || frame.sessionId !== sessionId) continue;
				const event = frame.event;
				if (event.type === "assistant/message") {
					const turn = event.data.turn;
					const text = assistantText(event);
					if (typeof turn === "number" && text !== void 0) this.pendingAssistantByTurn.set(turn, text);
					continue;
				}
				if (event.type !== "turn/end") continue;
				const turn = event.data.turn;
				if (typeof turn !== "number") continue;
				const text = this.pendingAssistantByTurn.get(turn);
				this.pendingAssistantByTurn.delete(turn);
				if (text === void 0) continue;
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
		"你是 DeepSeek Harness 的实时语音控制助理。使用自然、简短的中文对话。",
		"你只负责听懂用户、调用允许的 DSH 工具、查询进度和播报结果；不要自己假装修改代码。",
		"用户要求编写、修改、检查、运行或继续任何实际工作时，必须调用 start_task 或 send_task_message；绝不能只口头答应，也不要声称自己不能操作 Agent。收到工具成功结果后才能说已提交。",
		"运行中的紧急纠偏使用 send_task_message 的 steer；非紧急后续工作使用 queue。",
		"用户询问其他工作区、线程或会话时，先调用 list_sessions 检索；选中结果后再调用 get_session_latest_reply。不要把“当前没有运行任务”误当成“目标会话不存在”。",
		"start_task、send_task_message、get_task_status 和 cancel_task 始终作用于本次通话绑定的当前会话；跨会话工具目前只读。",
		"收到标记为“DSH Agent 刚完成”的系统上下文时，这是长期 DSH 会话的权威结果；简短播报并允许用户继续追问，不要把它当成新的工作指令。",
		"取消任务前，只有在用户意思明确时才调用 cancel_task。",
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
	"credentials"
];
/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
function apply(ctx, config) {
	const server = new WebSocketServer({ noServer: true });
	const connections = /* @__PURE__ */ new Set();
	const upgrade = (request, socket, head) => {
		if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (connections.size >= config.maxConnections) {
			socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		server.handleUpgrade(request, socket, head, (websocket) => {
			let connection;
			connection = new VoiceConnection(ctx, websocket, request, config, () => connections.delete(connection));
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