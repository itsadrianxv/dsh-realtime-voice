window.__ModuleLoader__.load({
	id: "@harness-remote/dsh-realtime-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
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
		function isRealtimeVoiceModel(value) {
			return value === REALTIME_VOICE_MODELS.flash || value === REALTIME_VOICE_MODELS.plus;
		}
		function isRealtimeVoiceTurnDetection(value) {
			return value === REALTIME_VOICE_TURN_DETECTION.fast || value === REALTIME_VOICE_TURN_DETECTION.semantic;
		}
		function realtimeVoiceModelLabel(model) {
			if (model === REALTIME_VOICE_MODELS.flash) return "Flash · 经济低延迟";
			if (model === REALTIME_VOICE_MODELS.plus) return "Plus · 高质量";
			return model ?? "未知模型";
		}
		function realtimeVoiceTurnDetectionLabel(mode) {
			if (mode === REALTIME_VOICE_TURN_DETECTION.fast) return "快速声学打断";
			if (mode === REALTIME_VOICE_TURN_DETECTION.semantic) return "智能语义轮次";
			return mode ?? "未知打断模式";
		}
		//#endregion
		//#region src/protocol.ts
		/** Versioned client-neutral wire contract shared by WebUI and WeChat Mini Program clients. */
		const VOICE_PROTOCOL = "dsh.voice.v1";
		const VOICE_ROUTE = "/plugins/realtime-voice/v1";
		const INPUT_SAMPLE_RATE = 16e3;
		const OUTPUT_SAMPLE_RATE = 24e3;
		const AUDIO_MAGIC = [
			68,
			83,
			86,
			49
		];
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
		//#endregion
		//#region src/client/audio-worklet-source.ts
		/** Self-contained AudioWorklet module: 16 kHz capture resampler plus 24 kHz streaming player. */
		const AUDIO_WORKLET_SOURCE = String.raw`
class DshVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.targetRate = options.processorOptions.targetSampleRate
    this.frameSamples = options.processorOptions.frameSamples
    this.pending = []
    this.position = 0
    this.output = []
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    for (let i = 0; i < input.length; i++) this.pending.push(input[i])
    const ratio = sampleRate / this.targetRate
    while (this.position + 1 < this.pending.length) {
      const left = Math.floor(this.position)
      const frac = this.position - left
      const sample = this.pending[left] * (1 - frac) + this.pending[left + 1] * frac
      this.output.push(Math.max(-1, Math.min(1, sample)))
      this.position += ratio
    }
    const consumed = Math.floor(this.position)
    if (consumed > 0) {
      this.pending.splice(0, consumed)
      this.position -= consumed
    }
    while (this.output.length >= this.frameSamples) {
      const frame = this.output.splice(0, this.frameSamples)
      const pcm = new Int16Array(frame.length)
      for (let i = 0; i < frame.length; i++) pcm[i] = frame[i] < 0 ? frame[i] * 32768 : frame[i] * 32767
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}

class DshVoicePlayback extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.sourceRate = options.processorOptions.sourceSampleRate
    this.queue = []
    this.offset = 0
    this.epoch = 0
    this.port.onmessage = (event) => {
      const message = event.data
      if (message.type === 'clear') {
        this.queue = []
        this.offset = 0
        this.epoch = message.epoch
        return
      }
      if (message.type !== 'audio' || message.epoch < this.epoch) return
      if (message.epoch > this.epoch) {
        this.queue = []
        this.offset = 0
        this.epoch = message.epoch
      }
      const source = new Int16Array(message.pcm)
      const ratio = this.sourceRate / sampleRate
      const outputLength = Math.max(1, Math.floor(source.length / ratio))
      const decoded = new Float32Array(outputLength)
      for (let i = 0; i < outputLength; i++) {
        const position = i * ratio
        const left = Math.floor(position)
        const right = Math.min(source.length - 1, left + 1)
        const frac = position - left
        decoded[i] = ((source[left] * (1 - frac)) + (source[right] * frac)) / 32768
      }
      this.queue.push(decoded)
    }
  }
  process(_inputs, outputs) {
    const output = outputs[0] && outputs[0][0]
    if (!output) return true
    output.fill(0)
    let written = 0
    while (written < output.length && this.queue.length > 0) {
      const chunk = this.queue[0]
      const count = Math.min(output.length - written, chunk.length - this.offset)
      output.set(chunk.subarray(this.offset, this.offset + count), written)
      written += count
      this.offset += count
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('dsh-voice-capture', DshVoiceCapture)
registerProcessor('dsh-voice-playback', DshVoicePlayback)
`;
		//#endregion
		//#region src/client/local-vad.ts
		const DEFAULT_OPTIONS = {
			rmsThreshold: .025,
			peakThreshold: .1,
			attackFrames: 2,
			releaseFrames: 5
		};
		/** Small browser-side onset detector used only to stop playback before the cloud VAD round trip. */
		var LocalVoiceActivityDetector = class {
			options;
			hotFrames = 0;
			quietFrames = 0;
			active = false;
			constructor(options = DEFAULT_OPTIONS) {
				this.options = options;
			}
			push(pcm) {
				const samples = new Int16Array(pcm);
				if (samples.length === 0) return false;
				let energy = 0;
				let peak = 0;
				for (const value of samples) {
					const normalized = Math.abs(value) / 32768;
					energy += normalized * normalized;
					peak = Math.max(peak, normalized);
				}
				if (Math.sqrt(energy / samples.length) >= this.options.rmsThreshold && peak >= this.options.peakThreshold) {
					this.quietFrames = 0;
					this.hotFrames += 1;
					if (!this.active && this.hotFrames >= this.options.attackFrames) {
						this.active = true;
						return true;
					}
					return false;
				}
				this.hotFrames = 0;
				if (!this.active) return false;
				this.quietFrames += 1;
				if (this.quietFrames >= this.options.releaseFrames) {
					this.active = false;
					this.quietFrames = 0;
				}
				return false;
			}
			reset() {
				this.hotFrames = 0;
				this.quietFrames = 0;
				this.active = false;
			}
		};
		//#endregion
		//#region src/client/audio-engine.ts
		/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
		var BrowserAudioEngine = class {
			onInput;
			onSpeechStart;
			context;
			stream;
			capture;
			playback;
			moduleUrl;
			playbackEpoch = 0;
			localVad = new LocalVoiceActivityDetector();
			constructor(onInput, onSpeechStart = () => {}) {
				this.onInput = onInput;
				this.onSpeechStart = onSpeechStart;
			}
			async start() {
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				} });
				const context = new AudioContext({ latencyHint: "interactive" });
				this.context = context;
				this.moduleUrl = URL.createObjectURL(new Blob([AUDIO_WORKLET_SOURCE], { type: "text/javascript" }));
				await context.audioWorklet.addModule(this.moduleUrl);
				const source = context.createMediaStreamSource(this.stream);
				const capture = new AudioWorkletNode(context, "dsh-voice-capture", {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [1],
					processorOptions: {
						targetSampleRate: INPUT_SAMPLE_RATE,
						frameSamples: 640
					}
				});
				const silent = context.createGain();
				silent.gain.value = 0;
				source.connect(capture);
				capture.connect(silent).connect(context.destination);
				capture.port.onmessage = (event) => {
					if (this.localVad.push(event.data)) this.onSpeechStart();
					this.onInput(event.data);
				};
				this.capture = capture;
				const playback = new AudioWorkletNode(context, "dsh-voice-playback", {
					numberOfInputs: 0,
					numberOfOutputs: 1,
					outputChannelCount: [1],
					processorOptions: { sourceSampleRate: OUTPUT_SAMPLE_RATE }
				});
				playback.connect(context.destination);
				this.playback = playback;
				await context.resume();
			}
			play(pcm, epoch) {
				this.playbackEpoch = Math.max(this.playbackEpoch, epoch);
				const transferable = pcm.slice().buffer;
				this.playback?.port.postMessage({
					type: "audio",
					epoch,
					pcm: transferable
				}, [transferable]);
			}
			clear(epoch) {
				this.playbackEpoch = epoch;
				this.playback?.port.postMessage({
					type: "clear",
					epoch
				});
			}
			/** Synchronous local barge-in; Host will confirm the same next stream epoch. */
			interruptPlayback() {
				this.clear(this.playbackEpoch + 1);
			}
			setMuted(muted) {
				for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
			}
			async close() {
				for (const track of this.stream?.getTracks() ?? []) track.stop();
				this.stream = void 0;
				this.capture?.disconnect();
				this.playback?.disconnect();
				this.capture = void 0;
				this.playback = void 0;
				this.playbackEpoch = 0;
				this.localVad.reset();
				if (this.context !== void 0 && this.context.state !== "closed") await this.context.close();
				this.context = void 0;
				if (this.moduleUrl !== void 0) URL.revokeObjectURL(this.moduleUrl);
				this.moduleUrl = void 0;
			}
		};
		//#endregion
		//#region src/client/controller.ts
		const INITIAL_SNAPSHOT = {
			phase: "idle",
			muted: false,
			userTranscript: "",
			assistantTranscript: "",
			agentRunning: false,
			elapsedSeconds: 0
		};
		/** Root-lifetime call controller shared by the session button and frame overlay through inject hooks. */
		var VoiceCallController = class {
			snapshot = INITIAL_SNAPSHOT;
			listeners = /* @__PURE__ */ new Set();
			socket;
			audio;
			inputSequence = 0;
			inputStreamId = 1;
			providerReady = false;
			startedAt = 0;
			timer;
			reconnectTimer;
			reconnectAttempt = 0;
			connectionEpoch = 0;
			lastReconnectError;
			ending = false;
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};
			async start(sessionId) {
				if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") return;
				if (!window.isSecureContext || navigator.mediaDevices?.getUserMedia === void 0) {
					this.update({
						...INITIAL_SNAPSHOT,
						phase: "error",
						error: "实时语音需要安全上下文：请使用 localhost 或 HTTPS。"
					});
					return;
				}
				this.ending = false;
				this.reconnectAttempt = 0;
				this.lastReconnectError = void 0;
				this.update({
					...INITIAL_SNAPSHOT,
					phase: "requesting-permission",
					sessionId
				});
				try {
					const audio = new BrowserAudioEngine((pcm) => this.sendAudio(pcm), () => this.handleLocalSpeechStart());
					this.audio = audio;
					await audio.start();
					this.startedAt = Date.now();
					this.timer = setInterval(() => this.tick(), 1e3);
					await this.connect(sessionId);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (this.reconnectTimer !== void 0) this.update({
						...this.snapshot,
						error: message
					});
					else await this.fail(message);
				}
			}
			async end() {
				if (this.snapshot.phase === "idle") return;
				this.ending = true;
				this.update({
					...this.snapshot,
					phase: "ending"
				});
				this.sendControl({
					type: "voice.end",
					reason: "user-ended"
				});
				await this.cleanup();
				this.update(INITIAL_SNAPSHOT);
			}
			toggleMute() {
				const muted = !this.snapshot.muted;
				this.audio?.setMuted(muted);
				this.update({
					...this.snapshot,
					muted
				});
			}
			cancelResponse() {
				this.audio?.interruptPlayback();
				this.sendControl({ type: "voice.cancel-response" });
			}
			async dispose() {
				this.ending = true;
				await this.cleanup();
				this.listeners.clear();
			}
			async connect(sessionId) {
				const epoch = ++this.connectionEpoch;
				const previous = this.socket;
				this.socket = void 0;
				if (previous !== void 0 && previous.readyState < WebSocket.CLOSING) previous.close(1e3, "voice-connection-superseded");
				this.update({
					...this.snapshot,
					phase: this.reconnectAttempt === 0 ? "connecting" : "reconnecting"
				});
				const scheme = location.protocol === "https:" ? "wss:" : "ws:";
				const socket = new WebSocket(`${scheme}//${location.host}${VOICE_ROUTE}`);
				socket.binaryType = "arraybuffer";
				this.socket = socket;
				await new Promise((resolve, reject) => {
					let settled = false;
					const readyTimeout = setTimeout(() => {
						if (this.socket !== socket || epoch !== this.connectionEpoch) return;
						this.lastReconnectError = "等待实时语音服务就绪超时。";
						this.scheduleReconnect(sessionId);
						if (socket.readyState < WebSocket.CLOSING) socket.close(4e3, "voice-ready-timeout");
						if (!settled) {
							settled = true;
							reject(new Error(this.lastReconnectError));
						}
					}, 25e3);
					const rejectOnce = (error) => {
						if (settled) return;
						settled = true;
						clearTimeout(readyTimeout);
						reject(error);
					};
					socket.onopen = () => {
						if (this.socket !== socket || epoch !== this.connectionEpoch) return;
						socket.send(JSON.stringify({
							type: "voice.hello",
							protocol: VOICE_PROTOCOL,
							requestId: crypto.randomUUID(),
							client: {
								platform: "web",
								version: "0.1.0",
								binaryWebSocket: true,
								playbackClear: true,
								pcmS16leVerified: true,
								foregroundOnly: false,
								duplex: "full"
							},
							target: { sessionId },
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
								}
							},
							...this.snapshot.voiceSessionId === void 0 ? {} : { resume: {
								voiceSessionId: this.snapshot.voiceSessionId,
								lastServerSeq: 0
							} }
						}));
					};
					socket.onmessage = (event) => {
						if (this.socket === socket && epoch === this.connectionEpoch) this.receive(event);
					};
					socket.onerror = () => {
						if (this.socket !== socket || epoch !== this.connectionEpoch) return;
						this.lastReconnectError = "无法连接 DSH 实时语音插件。";
						this.scheduleReconnect(sessionId);
						rejectOnce(new Error(this.lastReconnectError));
					};
					const ready = (event) => {
						if (this.socket !== socket || epoch !== this.connectionEpoch) return;
						if (typeof event.data !== "string") return;
						const message = JSON.parse(event.data);
						if (message.type === "voice.ready") {
							socket.removeEventListener("message", ready);
							clearTimeout(readyTimeout);
							this.providerReady = true;
							this.reconnectAttempt = 0;
							this.lastReconnectError = void 0;
							if (!settled) {
								settled = true;
								resolve();
							}
						}
						if (message.type === "voice.error" && !message.recoverable) {
							socket.removeEventListener("message", ready);
							this.lastReconnectError = message.message;
							this.scheduleReconnect(sessionId);
							rejectOnce(new Error(message.message));
						}
					};
					socket.addEventListener("message", ready);
					socket.onclose = (event) => {
						clearTimeout(readyTimeout);
						socket.removeEventListener("message", ready);
						if (this.socket !== socket || epoch !== this.connectionEpoch) return;
						this.socket = void 0;
						this.providerReady = false;
						this.audio?.clear(0);
						const reason = event.reason.trim();
						if (this.lastReconnectError === void 0 || reason !== "provider-disconnected") this.lastReconnectError = reason === "" ? `实时语音连接关闭（代码 ${event.code}）。` : `实时语音连接关闭（代码 ${event.code}：${reason}）。`;
						if (!this.ending) this.scheduleReconnect(sessionId);
						rejectOnce(new Error(this.lastReconnectError));
					};
				});
			}
			receive(event) {
				if (event.data instanceof ArrayBuffer) {
					const frame = decodeAudioFrame(event.data);
					if (frame.kind === 2) this.audio?.play(frame.payload, frame.streamId);
					return;
				}
				if (typeof event.data !== "string") return;
				const message = JSON.parse(event.data);
				switch (message.type) {
					case "voice.ready":
						this.update({
							...this.snapshot,
							phase: "listening",
							voiceSessionId: message.voiceSessionId,
							providerModel: message.provider.model,
							turnDetection: message.provider.turnDetection,
							agentRunning: message.target.running,
							error: void 0
						});
						return;
					case "voice.state":
						this.update({
							...this.snapshot,
							phase: message.phase,
							...message.phase === "thinking" && this.snapshot.phase !== "thinking" ? { assistantTranscript: "" } : {}
						});
						return;
					case "voice.transcript":
						if (message.role === "user") this.update({
							...this.snapshot,
							userTranscript: message.text + (message.stash ?? "")
						});
						else this.update({
							...this.snapshot,
							assistantTranscript: message.final ? message.text : this.snapshot.assistantTranscript + message.text
						});
						return;
					case "voice.playback-clear":
						this.audio?.clear(message.streamId);
						return;
					case "voice.agent-status":
						this.update({
							...this.snapshot,
							agentRunning: message.running,
							...message.summary === void 0 ? {} : { agentSummary: message.summary }
						});
						return;
					case "voice.error":
						if (message.recoverable) {
							this.lastReconnectError = message.message;
							this.update({
								...this.snapshot,
								error: message.message
							});
						} else this.fail(message.message);
						return;
					case "voice.ended":
						this.end();
						return;
					case "voice.tool":
					case "voice.pong": return;
				}
			}
			sendAudio(pcm) {
				const socket = this.socket;
				if (!this.providerReady || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1048576) return;
				const sequence = this.inputSequence++;
				socket.send(encodeAudioFrame(1, this.inputStreamId, sequence, pcm, { ptsMs: sequence * 40 }));
			}
			sendControl(message) {
				if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
			}
			scheduleReconnect(sessionId) {
				if (this.reconnectTimer !== void 0 || this.ending) return;
				if (this.reconnectAttempt >= 8) {
					const detail = this.lastReconnectError === void 0 ? "" : ` 最后原因：${this.lastReconnectError}`;
					this.fail(`实时语音连接多次重试失败，DSH 中已经开始的任务不会被取消。${detail}`);
					return;
				}
				const delay = /rate.?limit|限流|代码\s*1007/i.test(this.lastReconnectError ?? "") ? Math.min(6e4, 15e3 * 2 ** this.reconnectAttempt) : Math.min(3e4, 1e3 * 2 ** this.reconnectAttempt);
				this.reconnectAttempt += 1;
				this.update({
					...this.snapshot,
					phase: "reconnecting"
				});
				this.reconnectTimer = setTimeout(() => {
					this.reconnectTimer = void 0;
					this.connect(sessionId).catch((error) => {
						if (!this.ending) this.scheduleReconnect(sessionId);
						if (error instanceof Error) this.update({
							...this.snapshot,
							error: error.message
						});
					});
				}, delay);
			}
			tick() {
				if (this.startedAt === 0) return;
				this.update({
					...this.snapshot,
					elapsedSeconds: Math.floor((Date.now() - this.startedAt) / 1e3)
				});
			}
			/** Stop audible output before the server-side VAD event completes its round trip. */
			handleLocalSpeechStart() {
				if (this.snapshot.phase !== "speaking" || this.snapshot.muted || this.snapshot.turnDetection !== "server_vad") return;
				this.audio?.interruptPlayback();
				this.sendControl({ type: "voice.cancel-response" });
				this.update({
					...this.snapshot,
					phase: "listening"
				});
			}
			async fail(message) {
				this.ending = true;
				await this.cleanup();
				this.update({
					...INITIAL_SNAPSHOT,
					phase: "error",
					error: message
				});
			}
			async cleanup() {
				this.connectionEpoch += 1;
				if (this.timer !== void 0) clearInterval(this.timer);
				if (this.reconnectTimer !== void 0) clearTimeout(this.reconnectTimer);
				this.timer = void 0;
				this.reconnectTimer = void 0;
				const socket = this.socket;
				this.socket = void 0;
				if (socket !== void 0 && socket.readyState < WebSocket.CLOSING) socket.close(1e3, "voice client closed");
				await this.audio?.close();
				this.audio = void 0;
				this.startedAt = 0;
				this.providerReady = false;
				this.inputSequence = 0;
				this.inputStreamId += 1;
			}
			update(next) {
				this.snapshot = next;
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/model-settings.ts
		const DEFAULT_API_KEY_REF = "DASHSCOPE_API_KEY";
		/** Project one durable DSH settings namespace into an immediate two-model switch. */
		var VoiceModelSettingsController = class {
			scope;
			api;
			snapshot = {
				available: false,
				writable: false,
				model: DEFAULT_REALTIME_VOICE_MODEL,
				turnDetection: DEFAULT_REALTIME_VOICE_TURN_DETECTION,
				saving: false,
				error: void 0,
				apiKeyRef: DEFAULT_API_KEY_REF,
				apiKeyConfigured: false,
				apiKeyWritable: true,
				apiKeySaving: false,
				apiKeyError: void 0
			};
			listeners = /* @__PURE__ */ new Set();
			unsubscribe;
			constructor(scope, api) {
				this.scope = scope;
				this.api = api;
				this.unsubscribe = scope.subscribe(() => {
					this.adoptScope();
				});
				this.adoptScope();
				this.readCredential();
			}
			getSnapshot = () => this.snapshot;
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};
			async select(model) {
				if (!this.snapshot.available || !this.snapshot.writable || this.snapshot.saving || model === this.snapshot.model) return;
				this.publish({
					...this.snapshot,
					saving: true,
					error: void 0
				});
				try {
					await this.scope.set("model", model);
					if (this.scope.getSnapshot().value?.model !== model) throw new Error("DSH 没有接受该模型设置。");
					this.publish({
						...this.snapshot,
						model,
						saving: false,
						error: void 0
					});
				} catch (error) {
					this.publish({
						...this.snapshot,
						saving: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
			async selectTurnDetection(turnDetection) {
				if (!this.snapshot.available || !this.snapshot.writable || this.snapshot.saving || turnDetection === this.snapshot.turnDetection) return;
				this.publish({
					...this.snapshot,
					saving: true,
					error: void 0
				});
				try {
					await this.scope.set("turnDetection", turnDetection);
					if (this.scope.getSnapshot().value?.turnDetection !== turnDetection) throw new Error("DSH 没有接受该打断模式。");
					this.publish({
						...this.snapshot,
						turnDetection,
						saving: false,
						error: void 0
					});
				} catch (error) {
					this.publish({
						...this.snapshot,
						saving: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
			/** Write through DSH's write-only credential seam; the literal is never stored in this controller. */
			async saveApiKey(value) {
				const key = value.trim();
				if (key === "" || !this.snapshot.apiKeyWritable || this.snapshot.apiKeySaving) return false;
				const ref = this.apiKeyRef();
				this.publish({
					...this.snapshot,
					apiKeySaving: true,
					apiKeyError: void 0
				});
				try {
					if (!(await this.api.credentials.set({
						ref,
						value: key
					})).result.ok) throw new Error("DSH credentials 拒绝了该密钥。");
					await this.readCredential();
					const configured = this.snapshot.apiKeyRef === ref && this.snapshot.apiKeyConfigured;
					this.publish({
						...this.snapshot,
						apiKeySaving: false,
						apiKeyError: configured ? void 0 : "密钥写入后未能确认，请重试。"
					});
					return configured;
				} catch {
					this.publish({
						...this.snapshot,
						apiKeySaving: false,
						apiKeyError: "API Key 保存失败，请确认当前为本机 3080 WebUI。"
					});
					return false;
				}
			}
			/** Refresh only when the Host reports that this card's credential changed. */
			refreshCredential(ref) {
				if (ref === this.apiKeyRef()) this.readCredential();
			}
			dispose() {
				this.unsubscribe();
				this.listeners.clear();
			}
			adoptScope() {
				const scope = this.scope.getSnapshot();
				const model = scope.value?.model;
				const turnDetection = scope.value?.turnDetection;
				const previousRef = this.snapshot.apiKeyRef;
				const apiKeyRef = this.apiKeyRef();
				this.publish({
					...this.snapshot,
					available: scope.status === "ready" && isRealtimeVoiceModel(model) && isRealtimeVoiceTurnDetection(turnDetection),
					writable: scope.writable,
					...isRealtimeVoiceModel(model) ? { model } : {},
					...isRealtimeVoiceTurnDetection(turnDetection) ? { turnDetection } : {},
					apiKeyRef,
					...apiKeyRef === previousRef ? {} : { apiKeyConfigured: false }
				});
				if (apiKeyRef !== previousRef) this.readCredential();
			}
			async readCredential() {
				const ref = this.apiKeyRef();
				let response;
				try {
					response = await this.api.credentials.describe({ refs: [ref] });
				} catch {
					return;
				}
				if (!response.result.ok || ref !== this.apiKeyRef()) return;
				const credential = response.result.value.credentials[ref];
				this.publish({
					...this.snapshot,
					apiKeyRef: ref,
					apiKeyConfigured: credential?.configured ?? false,
					apiKeyWritable: credential?.writable ?? true
				});
			}
			apiKeyRef() {
				const declared = this.scope.getSnapshot().value?.apiKeyEnv?.trim();
				return declared === void 0 || declared === "" ? DEFAULT_API_KEY_REF : declared;
			}
			publish(next) {
				this.snapshot = next;
				for (const listener of this.listeners) listener();
			}
		};
		/** Reject malformed remote settings snapshots before they reach the switch. */
		function decodeVoiceModelSettings(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
			const model = value.model;
			if (!isRealtimeVoiceModel(model)) return void 0;
			const rawTurnDetection = value.turnDetection;
			const turnDetection = rawTurnDetection === void 0 ? DEFAULT_REALTIME_VOICE_TURN_DETECTION : rawTurnDetection;
			if (!isRealtimeVoiceTurnDetection(turnDetection)) return void 0;
			const apiKeyEnv = value.apiKeyEnv;
			if (apiKeyEnv !== void 0 && (typeof apiKeyEnv !== "string" || apiKeyEnv.trim() === "")) return void 0;
			return {
				model,
				turnDetection,
				...typeof apiKeyEnv === "string" ? { apiKeyEnv } : {}
			};
		}
		//#endregion
		//#region \0dsh-voice-css:E:\deepseek-harness\dsh-realtime-voice\src\client\voice.module.css.mjs
		const css = "._77KAyq_callButton{color:#fff;background:var(--dsw-alias-button-info-fill,#3964fe);cursor:pointer;border:0;border-radius:999px;flex:none;order:100;place-items:center;width:34px;height:34px;padding:0;transition:color .12s,background .12s,transform .12s,box-shadow .12s;display:inline-grid;transform:translateY(-2px)}._77KAyq_callButton:hover{background:var(--dsw-alias-button-info-hover,#2f55dc)}._77KAyq_callButton:active{transform:translateY(-2px)scale(.94)}._77KAyq_callButtonActive{color:var(--dsw-alias-button-danger-text,#fff);background:var(--dsw-alias-button-danger-fill,#e5484d);box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-button-danger-fill,#e5484d) 18%, transparent)}._77KAyq_icon{fill:none;stroke:currentColor;stroke-width:1.55px;stroke-linecap:round;stroke-linejoin:round;width:17px;height:17px}._77KAyq_stopGlyph{background:currentColor;border-radius:2px;width:8px;height:8px}._77KAyq_overlay{border:1px solid var(--dsw-alias-border-subtle);width:min(372px,100vw - 40px);max-height:min(620px,100vh - 24px);color:var(--dsw-alias-text-primary);background:color-mix(in srgb, var(--dsw-alias-surface-primary) 94%, transparent);backdrop-filter:blur(18px);will-change:left, top;border-radius:18px;flex-direction:column;padding:16px;display:flex;position:fixed;top:72px;right:20px;overflow:hidden;box-shadow:0 18px 56px #0000002e}._77KAyq_overlayError{gap:14px;width:min(372px,100vw - 40px)}._77KAyq_dragHandle,._77KAyq_voiceOrb{touch-action:none;user-select:none;cursor:grab}._77KAyq_dragging,._77KAyq_dragging ._77KAyq_dragHandle{cursor:grabbing;transition:none!important}._77KAyq_voiceOrb{border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#3964fe) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-surface-primary,#fff) 88%, transparent);width:76px;height:76px;box-shadow:0 14px 38px #00000038, 0 0 0 6px color-mix(in srgb, var(--dsw-alias-brand-primary,#3964fe) 10%, transparent);backdrop-filter:blur(18px);will-change:left, top;border-radius:50%;padding:0;position:fixed;bottom:20px;right:20px;overflow:hidden}._77KAyq_voiceOrb[data-phase=speaking]{box-shadow:0 14px 38px #00000038, 0 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary,#3964fe) 17%, transparent)}._77KAyq_orbButton{border-radius:inherit;color:#fff;width:100%;height:100%;cursor:inherit;background:radial-gradient(circle at 35% 28%,#7390ff 0,#3964fe 44%,#2747c9 100%);border:0;place-content:center;gap:5px;padding:0;display:grid}._77KAyq_orbWaves{justify-content:center;align-items:center;gap:3px;height:22px;display:flex}._77KAyq_orbWaves i{opacity:.92;background:currentColor;border-radius:999px;width:3px;height:8px;animation:.85s ease-in-out infinite alternate _77KAyq_voice-wave;display:block}._77KAyq_orbWaves i:nth-child(2),._77KAyq_orbWaves i:nth-child(4){height:15px;animation-delay:-240ms}._77KAyq_orbWaves i:nth-child(3){height:21px;animation-delay:-420ms}._77KAyq_voiceOrb[data-phase=listening] ._77KAyq_orbWaves i,._77KAyq_voiceOrb[data-phase=agent-working] ._77KAyq_orbWaves i{animation-duration:1.25s}._77KAyq_orbTime{font-variant-numeric:tabular-nums;opacity:.86;font-size:10px}@keyframes _77KAyq_voice-wave{0%{opacity:.62;transform:scaleY(.55)}to{opacity:1;transform:scaleY(1.15)}}._77KAyq_overlayHeader,._77KAyq_controls{justify-content:space-between;align-items:center;gap:10px;display:flex}._77KAyq_overlayHeader{border-radius:12px;margin:-8px -8px 0;padding:8px}._77KAyq_headerActions{align-items:center;gap:8px;display:flex}._77KAyq_iconButton{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));width:28px;height:28px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-surface-primary));cursor:pointer;border-radius:999px;font-size:20px;line-height:1}._77KAyq_eyebrow{color:var(--dsw-alias-text-secondary);margin-bottom:4px;font-size:12px;font-weight:600}._77KAyq_phaseLine{align-items:center;gap:7px;font-size:15px;font-weight:600;display:flex}._77KAyq_liveDot{background:var(--dsw-alias-status-success,#30a46c);width:8px;height:8px;box-shadow:0 0 0 5px color-mix(in srgb, var(--dsw-alias-status-success,#30a46c) 18%, transparent);border-radius:50%}._77KAyq_agentState{color:var(--dsw-alias-text-secondary);background:var(--dsw-alias-fill-subtle);border-radius:999px;padding:6px 10px;font-size:12px}._77KAyq_bindingCard{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-fill-subtle));border-radius:12px;margin-top:14px;padding:12px}._77KAyq_bindingLabel,._77KAyq_speakerLabel{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));font-size:11px;font-weight:600}._77KAyq_bindingTitle{color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary));text-overflow:ellipsis;white-space:nowrap;margin-top:3px;font-size:14px;font-weight:600;overflow:hidden}._77KAyq_bindingMeta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));margin-top:5px;font-size:11px;line-height:1.45}._77KAyq_returnLink{color:var(--dsw-alias-brand-primary,#3964fe);cursor:pointer;background:0 0;border:0;margin-top:8px;padding:0;font-size:12px}._77KAyq_transcripts{align-content:start;gap:12px;min-height:120px;max-height:230px;margin:14px 0;padding:2px 4px 2px 2px;display:grid;overflow-y:auto}._77KAyq_transcriptBlock{background:var(--dsw-alias-fill-subtle,var(--dsw-alias-bg-layer-3));border-radius:12px;gap:4px;padding:10px 12px;display:grid}._77KAyq_userText,._77KAyq_assistantText{margin:0;line-height:1.5}._77KAyq_userText{color:var(--dsw-alias-text-secondary);font-size:13px}._77KAyq_assistantText{font-size:15px}._77KAyq_agentSummary{border-left:3px solid var(--dsw-alias-brand-primary,#3964fe);max-height:120px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-fill-subtle));border-radius:0 10px 10px 0;gap:5px;margin-bottom:12px;padding:10px 12px;font-size:12px;line-height:1.5;display:grid;overflow-y:auto}._77KAyq_controls{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));flex-wrap:wrap;justify-content:flex-end;margin-top:auto;padding-top:12px}._77KAyq_secondaryButton,._77KAyq_endButton{border:1px solid var(--dsw-alias-border-subtle);color:var(--dsw-alias-text-primary);background:var(--dsw-alias-surface-primary);cursor:pointer;border-radius:999px;padding:7px 12px}._77KAyq_endButton{color:#fff;background:var(--dsw-alias-button-danger-fill,#e5484d);border-color:#0000}._77KAyq_inlineError,._77KAyq_errorText{color:var(--dsw-alias-status-danger-text,#d13438);font-size:13px}._77KAyq_errorText{flex:1}._77KAyq_settingsCard{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-surface-primary));border-radius:12px;list-style:none}._77KAyq_settingsCardHeader{align-items:center;gap:12px;padding:14px 16px;display:flex}._77KAyq_settingsCardIcon{color:#fff;background:var(--dsw-alias-button-info-fill,#3964fe);border-radius:10px;flex:none;place-items:center;width:34px;height:34px;display:grid}._77KAyq_settingsCardHeading{gap:3px;min-width:0;display:grid}._77KAyq_settingsCardHeading strong{font-size:15px}._77KAyq_settingsCardHeading span{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));font-size:13px;line-height:1.45}._77KAyq_settingsCardBody{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));margin:0 16px;padding:14px 0 16px}._77KAyq_settingsLabel{margin-bottom:9px;font-size:13px;font-weight:600}._77KAyq_modelSwitch{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;display:grid}._77KAyq_modelChoice{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));min-width:0;color:inherit;background:var(--dsw-alias-bg-layer-2,transparent);text-align:left;cursor:pointer;border-radius:10px;padding:11px 34px 11px 12px;position:relative}._77KAyq_modelChoiceSelected{border-color:var(--dsw-alias-brand-primary,#3964fe);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#3964fe)}._77KAyq_modelChoice:disabled{opacity:.55;cursor:default}._77KAyq_modelChoiceTitle,._77KAyq_modelChoiceDetail{display:block}._77KAyq_modelChoiceTitle{font-size:14px;font-weight:600}._77KAyq_modelChoiceDetail{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));margin-top:4px;font-size:11px;line-height:1.4}._77KAyq_radioDot{border:1px solid var(--dsw-alias-label-dimmed,#8a8f98);border-radius:50%;width:12px;height:12px;position:absolute;top:13px;right:12px}._77KAyq_modelChoiceSelected ._77KAyq_radioDot{border:4px solid var(--dsw-alias-brand-primary,#3964fe)}._77KAyq_settingsHint,._77KAyq_settingsError{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));margin:9px 0 0;font-size:12px;line-height:1.5}._77KAyq_settingsSubsection{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));margin-top:14px;padding-top:14px}._77KAyq_settingsError{color:var(--dsw-alias-label-error,#d13438)}._77KAyq_credentialSection{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));margin-top:14px;padding-top:14px}._77KAyq_credentialStatus{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-secondary));align-items:center;gap:7px;margin-bottom:9px;font-size:12px;display:flex}._77KAyq_credentialDot{background:var(--dsw-alias-label-error,#d13438);border-radius:50%;flex:none;width:7px;height:7px}._77KAyq_credentialStatus[data-configured] ._77KAyq_credentialDot{background:var(--dsw-alias-status-success,#30a46c);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-status-success,#30a46c) 14%, transparent)}._77KAyq_credentialInputRow{gap:8px;display:flex}._77KAyq_credentialInput{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-subtle));min-width:0;height:36px;color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-surface-primary));font:inherit;border-radius:8px;outline:none;flex:1;padding:0 11px;font-size:13px}._77KAyq_credentialInput:focus{border-color:var(--dsw-alias-brand-primary,#3964fe)}._77KAyq_credentialSave{color:#fff;background:var(--dsw-alias-button-info-fill,#3964fe);height:36px;font:inherit;cursor:pointer;border:0;border-radius:8px;flex:none;padding:0 13px;font-size:13px}._77KAyq_credentialSave:disabled,._77KAyq_credentialInput:disabled{opacity:.5;cursor:default}@media (width<=1199px){._77KAyq_overlay{border-radius:16px;width:min(420px,100vw - 24px);max-height:min(560px,100vh - 24px);padding:14px;top:auto;bottom:12px;right:12px}._77KAyq_voiceOrb{bottom:12px;right:12px}._77KAyq_controls{justify-content:stretch}._77KAyq_secondaryButton,._77KAyq_endButton{flex:1}}@media (width<=520px){._77KAyq_modelSwitch{grid-template-columns:1fr}}";
		const styleId = "@harness-remote/dsh-realtime-voice/voice.module.css";
		if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
			const style = document.createElement("style");
			style.dataset.plugin = "@harness-remote/dsh-realtime-voice";
			style.dataset.pluginCss = styleId;
			style.textContent = css;
			document.head.appendChild(style);
		}
		var voice_module_css_default = {
			"modelChoice": "_77KAyq_modelChoice",
			"bindingTitle": "_77KAyq_bindingTitle",
			"phaseLine": "_77KAyq_phaseLine",
			"transcripts": "_77KAyq_transcripts",
			"eyebrow": "_77KAyq_eyebrow",
			"voiceOrb": "_77KAyq_voiceOrb",
			"settingsCardHeader": "_77KAyq_settingsCardHeader",
			"agentSummary": "_77KAyq_agentSummary",
			"bindingCard": "_77KAyq_bindingCard",
			"endButton": "_77KAyq_endButton",
			"dragging": "_77KAyq_dragging",
			"settingsCardBody": "_77KAyq_settingsCardBody",
			"credentialStatus": "_77KAyq_credentialStatus",
			"orbWaves": "_77KAyq_orbWaves",
			"modelChoiceDetail": "_77KAyq_modelChoiceDetail",
			"credentialSave": "_77KAyq_credentialSave",
			"headerActions": "_77KAyq_headerActions",
			"liveDot": "_77KAyq_liveDot",
			"bindingMeta": "_77KAyq_bindingMeta",
			"assistantText": "_77KAyq_assistantText",
			"secondaryButton": "_77KAyq_secondaryButton",
			"settingsCard": "_77KAyq_settingsCard",
			"settingsError": "_77KAyq_settingsError",
			"userText": "_77KAyq_userText",
			"bindingLabel": "_77KAyq_bindingLabel",
			"callButtonActive": "_77KAyq_callButtonActive",
			"orbTime": "_77KAyq_orbTime",
			"credentialSection": "_77KAyq_credentialSection",
			"overlay": "_77KAyq_overlay",
			"settingsCardHeading": "_77KAyq_settingsCardHeading",
			"settingsCardIcon": "_77KAyq_settingsCardIcon",
			"voice-wave": "_77KAyq_voice-wave",
			"iconButton": "_77KAyq_iconButton",
			"credentialInput": "_77KAyq_credentialInput",
			"overlayError": "_77KAyq_overlayError",
			"settingsLabel": "_77KAyq_settingsLabel",
			"modelSwitch": "_77KAyq_modelSwitch",
			"modelChoiceSelected": "_77KAyq_modelChoiceSelected",
			"dragHandle": "_77KAyq_dragHandle",
			"errorText": "_77KAyq_errorText",
			"speakerLabel": "_77KAyq_speakerLabel",
			"icon": "_77KAyq_icon",
			"agentState": "_77KAyq_agentState",
			"orbButton": "_77KAyq_orbButton",
			"inlineError": "_77KAyq_inlineError",
			"controls": "_77KAyq_controls",
			"transcriptBlock": "_77KAyq_transcriptBlock",
			"returnLink": "_77KAyq_returnLink",
			"radioDot": "_77KAyq_radioDot",
			"credentialDot": "_77KAyq_credentialDot",
			"modelChoiceTitle": "_77KAyq_modelChoiceTitle",
			"callButton": "_77KAyq_callButton",
			"settingsSubsection": "_77KAyq_settingsSubsection",
			"stopGlyph": "_77KAyq_stopGlyph",
			"settingsHint": "_77KAyq_settingsHint",
			"overlayHeader": "_77KAyq_overlayHeader",
			"credentialInputRow": "_77KAyq_credentialInputRow"
		};
		//#endregion
		//#region src/client/VoiceButton.tsx
		/** Compact call control in the official composer right-hand action slot. */
		function VoiceButton({ useVoice, toggle }) {
			const phase = useVoice((snapshot) => snapshot.phase);
			const active = phase !== "idle" && phase !== "error";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `${voice_module_css_default.callButton} ${active ? voice_module_css_default.callButtonActive : ""}`,
				"aria-label": active ? "结束实时语音" : "开始实时语音",
				title: active ? "结束实时语音" : "实时语音",
				onClick: toggle,
				children: active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: voice_module_css_default.stopGlyph }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CallGlyph, {})
			});
		}
		function CallGlyph() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 24 24",
				"aria-hidden": "true",
				className: voice_module_css_default.icon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fill: "currentColor",
					stroke: "none",
					d: "M7.2 3.75 9.6 7.7 7.95 9.3c1.2 2.55 3.2 4.55 5.75 5.75l1.6-1.65 3.95 2.4-.55 3.4c-.14.85-.9 1.45-1.76 1.39C9.8 20.08 3.92 14.2 3.41 7.06A1.68 1.68 0 0 1 4.8 5.3l2.4-1.55Z"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fill: "none",
					d: "M14.2 5.8c1.85.46 3.54 2.15 4 4M14.55 2.5c3.45.58 6.37 3.5 6.95 6.95"
				})]
			});
		}
		function defaultFloatingPosition(viewport, panel) {
			return clampFloatingPosition({
				x: viewport.width - panel.width - 12,
				y: Math.max(72, viewport.height - panel.height - 12)
			}, viewport, panel);
		}
		function clampFloatingPosition(position, viewport, panel) {
			const maxX = Math.max(12, viewport.width - panel.width - 12);
			const maxY = Math.max(12, viewport.height - panel.height - 12);
			return {
				x: Math.min(maxX, Math.max(12, position.x)),
				y: Math.min(maxY, Math.max(12, position.y))
			};
		}
		function moveFloatingPosition(origin, pointerStart, pointerNow, viewport, panel) {
			return clampFloatingPosition({
				x: origin.x + pointerNow.x - pointerStart.x,
				y: origin.y + pointerNow.y - pointerStart.y
			}, viewport, panel);
		}
		//#endregion
		//#region src/client/VoiceOverlay.tsx
		/** Root-level movable call surface that remains visible while the user changes DSH sessions. */
		function VoiceOverlay({ useVoice, useSessions, end, toggleMute, cancelResponse, openSession }) {
			const voice = useVoice((snapshot) => snapshot);
			const [collapsed, setCollapsed] = (0, react.useState)(false);
			const [dragging, setDragging] = (0, react.useState)(false);
			const [position, setPosition] = (0, react.useState)();
			const panelRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)();
			const movedRef = (0, react.useRef)(false);
			const boundSession = useSessions((state) => voice.sessionId === void 0 ? void 0 : state.byId[voice.sessionId]);
			const currentSessionId = useSessions((state) => state.current);
			const viewingOtherSession = voice.sessionId !== void 0 && currentSessionId !== voice.sessionId;
			(0, react.useEffect)(() => {
				if (voice.phase === "requesting-permission") setCollapsed(false);
			}, [voice.phase]);
			(0, react.useEffect)(() => {
				const panel = panelRef.current;
				if (panel === null || voice.phase === "idle") return;
				let frame = 0;
				const fit = () => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(() => {
						const rect = panel.getBoundingClientRect();
						const viewport = {
							width: window.innerWidth,
							height: window.innerHeight
						};
						const size = {
							width: rect.width,
							height: rect.height
						};
						setPosition((current) => current === void 0 ? defaultFloatingPosition(viewport, size) : clampFloatingPosition(current, viewport, size));
					});
				};
				fit();
				window.addEventListener("resize", fit);
				const observer = typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(fit);
				observer?.observe(panel);
				return () => {
					cancelAnimationFrame(frame);
					window.removeEventListener("resize", fit);
					observer?.disconnect();
				};
			}, [collapsed, voice.phase]);
			const beginDrag = (event) => {
				if (event.button !== 0 || panelRef.current === null) return;
				if (!collapsed && event.target.closest("button") !== null) return;
				const rect = panelRef.current.getBoundingClientRect();
				dragRef.current = {
					pointerId: event.pointerId,
					pointerStart: {
						x: event.clientX,
						y: event.clientY
					},
					origin: {
						x: rect.left,
						y: rect.top
					}
				};
				movedRef.current = false;
				setDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
				event.preventDefault();
			};
			const moveDrag = (event) => {
				const drag = dragRef.current;
				const panel = panelRef.current;
				if (drag === void 0 || drag.pointerId !== event.pointerId || panel === null) return;
				if (Math.abs(event.clientX - drag.pointerStart.x) + Math.abs(event.clientY - drag.pointerStart.y) > 4) movedRef.current = true;
				const rect = panel.getBoundingClientRect();
				setPosition(moveFloatingPosition(drag.origin, drag.pointerStart, {
					x: event.clientX,
					y: event.clientY
				}, {
					width: window.innerWidth,
					height: window.innerHeight
				}, {
					width: rect.width,
					height: rect.height
				}));
			};
			const endDrag = (event) => {
				if (dragRef.current?.pointerId !== event.pointerId) return;
				dragRef.current = void 0;
				setDragging(false);
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
			};
			if (voice.phase === "idle") return null;
			const floatingStyle = position === void 0 ? void 0 : {
				left: position.x,
				top: position.y,
				right: "auto",
				bottom: "auto"
			};
			if (collapsed && voice.phase !== "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				ref: panelRef,
				className: `${voice_module_css_default.voiceOrb} ${dragging ? voice_module_css_default.dragging : ""}`,
				style: floatingStyle,
				"data-phase": voice.phase,
				"aria-label": `实时语音：${phaseText(voice.phase)}`,
				onPointerDown: beginDrag,
				onPointerMove: moveDrag,
				onPointerUp: endDrag,
				onPointerCancel: endDrag,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: voice_module_css_default.orbButton,
					"aria-label": "展开实时语音",
					title: "拖动悬浮球；点击展开",
					onClick: () => {
						if (movedRef.current) {
							movedRef.current = false;
							return;
						}
						setCollapsed(false);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: voice_module_css_default.orbWaves,
						"aria-hidden": true,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: voice_module_css_default.orbTime,
						children: formatElapsed(voice.elapsedSeconds)
					})]
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				ref: panelRef,
				className: `${voice_module_css_default.overlay} ${voice.phase === "error" ? voice_module_css_default.overlayError : ""} ${dragging ? voice_module_css_default.dragging : ""}`,
				style: floatingStyle,
				"aria-label": "实时语音通话",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: `${voice_module_css_default.overlayHeader} ${voice_module_css_default.dragHandle}`,
					title: "拖动语音窗口",
					onPointerDown: beginDrag,
					onPointerMove: moveDrag,
					onPointerUp: endDrag,
					onPointerCancel: endDrag,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.eyebrow,
						children: "DSH 实时语音"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.phaseLine,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: voice_module_css_default.liveDot }),
							phaseText(voice.phase),
							" · ",
							formatElapsed(voice.elapsedSeconds)
						]
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.headerActions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: voice_module_css_default.agentState,
							children: voice.agentRunning ? "Agent 工作中" : "Agent 待命"
						}), voice.phase === "error" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.iconButton,
							"aria-label": "收起为悬浮球",
							title: "收起为悬浮球",
							onClick: () => setCollapsed(true),
							children: "−"
						})]
					})]
				}), voice.phase === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: voice_module_css_default.errorText,
					children: voice.error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: voice_module_css_default.secondaryButton,
					onClick: () => void end(),
					children: "关闭"
				})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.bindingCard,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: voice_module_css_default.bindingLabel,
								children: "本次通话一对一绑定"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: voice_module_css_default.bindingTitle,
								children: boundSession?.displayTitle ?? "当前 DSH 会话"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: voice_module_css_default.bindingMeta,
								children: [
									boundSession?.blank === true ? "空白新会话 · 首个 Agent 指令会写入第一轮" : "工作指令与 Agent 结果保存在此线程",
									" · ",
									realtimeVoiceModelLabel(voice.providerModel),
									" · ",
									realtimeVoiceTurnDetectionLabel(voice.turnDetection)
								]
							}),
							viewingOtherSession ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.returnLink,
								onClick: () => openSession(voice.sessionId),
								children: "当前正在查看其他线程，返回绑定线程"
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.transcripts,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.transcriptBlock,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: voice_module_css_default.speakerLabel,
								children: "你"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: voice_module_css_default.userText,
								children: voice.userTranscript || "正在聆听…"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.transcriptBlock,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: voice_module_css_default.speakerLabel,
								children: "语音 Agent"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: voice_module_css_default.assistantText,
								children: voice.assistantTranscript || "你可以直接交代任务、追问进度或随时纠正方向。"
							})]
						})]
					}),
					voice.agentSummary === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.agentSummary,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "DSH Agent 最新结果" }), voice.agentSummary]
					}),
					voice.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.inlineError,
						children: voice.error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: voice_module_css_default.controls,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.secondaryButton,
								onClick: toggleMute,
								children: voice.muted ? "取消静音" : "静音"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.secondaryButton,
								onClick: cancelResponse,
								children: "立即打断"
							}),
							voice.sessionId === void 0 || !viewingOtherSession ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.secondaryButton,
								onClick: () => openSession(voice.sessionId),
								children: "返回任务"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.endButton,
								onClick: () => void end(),
								children: "结束"
							})
						]
					})
				] })]
			});
		}
		function phaseText(phase) {
			switch (phase) {
				case "requesting-permission": return "请求麦克风";
				case "connecting": return "正在接通";
				case "listening": return "正在聆听";
				case "thinking": return "正在思考";
				case "agent-working": return "正在操作 DSH";
				case "speaking": return "正在回答";
				case "reconnecting": return "正在重连";
				case "ending": return "正在结束";
				case "idle": return "待机";
				case "error": return "出错";
			}
		}
		function formatElapsed(seconds) {
			return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
		}
		//#endregion
		//#region src/client/VoiceSettingsCard.tsx
		/** One native Plugins-settings card. Changes persist immediately and affect the next call. */
		function VoiceSettingsCard({ useVoiceModelSettings, selectModel, selectTurnDetection, saveApiKey }) {
			const state = useVoiceModelSettings((snapshot) => snapshot);
			const [apiKey, setApiKey] = (0, react.useState)("");
			if (!state.available) return null;
			const disabled = !state.writable || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: voice_module_css_default.settingsCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: voice_module_css_default.settingsCardHeader,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: voice_module_css_default.settingsCardIcon,
						"aria-hidden": true,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WaveGlyph, {})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: voice_module_css_default.settingsCardHeading,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "DSH 实时语音" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "选择语音理解、全双工通话和工具调度使用的百炼模型。" })]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: voice_module_css_default.settingsCardBody,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: voice_module_css_default.settingsLabel,
							children: "实时语音模型"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.modelSwitch,
							role: "radiogroup",
							"aria-label": "实时语音模型",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
								title: "Flash",
								detail: "经济 · 低延迟 · 推荐日常使用",
								selected: state.model === REALTIME_VOICE_MODELS.flash,
								disabled,
								onClick: () => selectModel(REALTIME_VOICE_MODELS.flash)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
								title: "Plus",
								detail: "高质量 · 成本更高",
								selected: state.model === REALTIME_VOICE_MODELS.plus,
								disabled,
								onClick: () => selectModel(REALTIME_VOICE_MODELS.plus)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.settingsHint,
							children: state.saving ? "正在保存…" : "设置即时保存，从下一通电话开始生效；不会中断正在进行的通话。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.settingsSubsection,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: voice_module_css_default.settingsLabel,
									children: "VAD 打断方式"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.modelSwitch,
									role: "radiogroup",
									"aria-label": "VAD 打断方式",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
										title: "快速打断",
										detail: "声学 VAD + 本地停播 · 推荐",
										selected: state.turnDetection === REALTIME_VOICE_TURN_DETECTION.fast,
										disabled,
										onClick: () => selectTurnDetection(REALTIME_VOICE_TURN_DETECTION.fast)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
										title: "智能轮次",
										detail: "过滤附和与背景音 · 更保守",
										selected: state.turnDetection === REALTIME_VOICE_TURN_DETECTION.semantic,
										disabled,
										onClick: () => selectTurnDetection(REALTIME_VOICE_TURN_DETECTION.semantic)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.settingsHint,
									children: "快速打断会在检测到你开口后立即清空本地播报，并取消云端旧响应。"
								})
							]
						}),
						state.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.settingsError,
							role: "alert",
							children: state.error
						}),
						state.writable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.settingsHint,
							children: "当前连接不能修改主机设置，请在本机 3080 WebUI 中操作。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.credentialSection,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: voice_module_css_default.settingsLabel,
									children: "阿里云百炼 API Key"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.credentialStatus,
									"data-configured": state.apiKeyConfigured || void 0,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: voice_module_css_default.credentialDot }), state.apiKeyConfigured ? `已自动检测到 ${state.apiKeyRef}（环境变量或 DSH 凭据）` : `未检测到 ${state.apiKeyRef}`]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: voice_module_css_default.credentialInputRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "password",
										autoComplete: "off",
										spellCheck: false,
										className: voice_module_css_default.credentialInput,
										value: apiKey,
										placeholder: state.apiKeyConfigured ? "输入新 Key 可安全替换" : "sk-…",
										"aria-label": "阿里云百炼 API Key",
										disabled: !state.apiKeyWritable || state.apiKeySaving,
										onChange: (event) => setApiKey(event.target.value)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: voice_module_css_default.credentialSave,
										disabled: !state.apiKeyWritable || state.apiKeySaving || apiKey.trim() === "",
										onClick: () => {
											saveApiKey(apiKey).then((saved) => {
												if (saved) setApiKey("");
											});
										},
										children: state.apiKeySaving ? "保存中…" : "保存 Key"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.settingsHint,
									children: "密钥通过 DSH 官方 credentials 写入，只能检查是否存在，浏览器无法回读明文。"
								}),
								state.apiKeyError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: voice_module_css_default.settingsError,
									role: "alert",
									children: state.apiKeyError
								})
							]
						})
					]
				})]
			});
		}
		function ModelChoice(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				role: "radio",
				"aria-checked": props.selected,
				className: `${voice_module_css_default.modelChoice} ${props.selected ? voice_module_css_default.modelChoiceSelected : ""}`,
				disabled: props.disabled,
				onClick: props.onClick,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: voice_module_css_default.modelChoiceTitle,
						children: props.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: voice_module_css_default.modelChoiceDetail,
						children: props.detail
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: voice_module_css_default.radioDot,
						"aria-hidden": true
					})
				]
			});
		}
		function WaveGlyph() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 24 24",
				className: voice_module_css_default.icon,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 13v-2M8 16V8M12 19V5M16 16V8M20 13v-2" })
			});
		}
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"slots",
			"sessions",
			"connection",
			"remote",
			"settingsScope"
		];
		/** Register one composer action and one frame overlay; both disappear with this client fiber. */
		function apply(ctx) {
			const voice = new VoiceCallController();
			const { api } = ctx.get("connection");
			const modelSettings = new VoiceModelSettingsController(ctx.settingsScope.bind({
				namespace: REALTIME_VOICE_SETTINGS_NAMESPACE,
				decode: decodeVoiceModelSettings
			}), api);
			ctx.effect(() => async () => {
				modelSettings.dispose();
				await voice.dispose();
			}, "realtime-voice: browser media and settings lifecycle");
			ctx.effect(() => ctx.remote.$on("credentials/updated", (ref) => {
				modelSettings.refreshCredential(ref);
			}), "realtime-voice: credential state invalidation");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "realtime-voice",
				order: 20,
				inject: (sessionId) => ({
					hooks: { voice },
					toggle: () => {
						const phase = voice.getSnapshot().phase;
						if (phase === "idle" || phase === "error") voice.start(sessionId);
						else voice.end();
					}
				})
			}, VoiceButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "realtime-voice",
				order: 100,
				inject: () => ({
					hooks: { voice },
					end: () => voice.end(),
					toggleMute: () => voice.toggleMute(),
					cancelResponse: () => voice.cancelResponse(),
					openSession: (sessionId) => {
						ctx.sessions.open(sessionId);
					}
				})
			}, VoiceOverlay));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: REALTIME_VOICE_SETTINGS_NAMESPACE,
				priority: 30,
				inject: () => ({
					hooks: { voiceModelSettings: modelSettings },
					selectModel: (model) => {
						modelSettings.select(model);
					},
					selectTurnDetection: (mode) => {
						modelSettings.selectTurnDetection(mode);
					},
					saveApiKey: (value) => modelSettings.saveApiKey(value)
				})
			}, VoiceSettingsCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map