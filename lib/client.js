window.__ModuleLoader__.load({
	id: "@harness-remote/dsh-realtime-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/audio-engine.ts
		/** Browser microphone capture and streaming PCM playback; owns every browser media resource it creates. */
		var BrowserAudioEngine = class {
			onInput;
			context;
			stream;
			capture;
			playback;
			moduleUrl;
			constructor(onInput) {
				this.onInput = onInput;
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
				capture.port.onmessage = (event) => this.onInput(event.data);
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
				const transferable = pcm.slice().buffer;
				this.playback?.port.postMessage({
					type: "audio",
					epoch,
					pcm: transferable
				}, [transferable]);
			}
			clear(epoch) {
				this.playback?.port.postMessage({
					type: "clear",
					epoch
				});
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
					const audio = new BrowserAudioEngine((pcm) => this.sendAudio(pcm));
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
							agentRunning: message.target.running,
							error: void 0
						});
						return;
					case "voice.state":
						this.update({
							...this.snapshot,
							phase: message.phase
						});
						return;
					case "voice.transcript":
						if (message.role === "user") this.update({
							...this.snapshot,
							userTranscript: message.text + (message.stash ?? "")
						});
						else this.update({
							...this.snapshot,
							assistantTranscript: message.text
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
		//#region \0dsh-voice-css:E:\deepseek-harness\dsh-realtime-voice\src\client\voice.module.css.mjs
		const css = "._77KAyq_callButton{width:30px;height:30px;color:var(--dsw-alias-text-secondary);cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;place-items:center;padding:0;transition:color .12s,background .12s,transform .12s;display:inline-grid}._77KAyq_callButton:hover{color:var(--dsw-alias-text-primary);background:var(--dsw-alias-fill-hover)}._77KAyq_callButton:active{transform:scale(.94)}._77KAyq_callButtonActive{color:var(--dsw-alias-button-danger-text,#fff);background:var(--dsw-alias-button-danger-fill,#e5484d);box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-button-danger-fill,#e5484d) 18%, transparent)}._77KAyq_icon{fill:none;stroke:currentColor;stroke-width:1.8px;stroke-linecap:round;stroke-linejoin:round;width:18px;height:18px}._77KAyq_stopGlyph{background:currentColor;border-radius:2px;width:8px;height:8px}._77KAyq_overlay{border:1px solid var(--dsw-alias-border-subtle);width:min(560px,100vw - 32px);color:var(--dsw-alias-text-primary);background:color-mix(in srgb, var(--dsw-alias-surface-primary) 94%, transparent);backdrop-filter:blur(18px);border-radius:20px;padding:18px;position:fixed;bottom:24px;left:50%;transform:translate(-50%);box-shadow:0 20px 60px #0003}._77KAyq_overlayError{align-items:center;gap:14px;display:flex}._77KAyq_overlayHeader,._77KAyq_controls{justify-content:space-between;align-items:center;gap:10px;display:flex}._77KAyq_eyebrow{color:var(--dsw-alias-text-secondary);margin-bottom:4px;font-size:12px;font-weight:600}._77KAyq_phaseLine{align-items:center;gap:7px;font-size:15px;font-weight:600;display:flex}._77KAyq_liveDot{background:var(--dsw-alias-status-success,#30a46c);width:8px;height:8px;box-shadow:0 0 0 5px color-mix(in srgb, var(--dsw-alias-status-success,#30a46c) 18%, transparent);border-radius:50%}._77KAyq_agentState{color:var(--dsw-alias-text-secondary);background:var(--dsw-alias-fill-subtle);border-radius:999px;padding:6px 10px;font-size:12px}._77KAyq_transcripts{background:var(--dsw-alias-fill-subtle);border-radius:14px;gap:8px;min-height:92px;margin:16px 0;padding:14px;display:grid}._77KAyq_userText,._77KAyq_assistantText{margin:0;line-height:1.5}._77KAyq_userText{color:var(--dsw-alias-text-secondary);font-size:13px}._77KAyq_assistantText{font-size:15px}._77KAyq_controls{flex-wrap:wrap;justify-content:flex-end}._77KAyq_secondaryButton,._77KAyq_endButton{border:1px solid var(--dsw-alias-border-subtle);color:var(--dsw-alias-text-primary);background:var(--dsw-alias-surface-primary);cursor:pointer;border-radius:999px;padding:7px 12px}._77KAyq_endButton{color:#fff;background:var(--dsw-alias-button-danger-fill,#e5484d);border-color:#0000}._77KAyq_inlineError,._77KAyq_errorText{color:var(--dsw-alias-status-danger-text,#d13438);font-size:13px}._77KAyq_errorText{flex:1}@media (width<=640px){._77KAyq_overlay{border-radius:16px;padding:14px;bottom:12px}._77KAyq_controls{justify-content:stretch}._77KAyq_secondaryButton,._77KAyq_endButton{flex:1}}";
		const styleId = "@harness-remote/dsh-realtime-voice/voice.module.css";
		if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
			const style = document.createElement("style");
			style.dataset.plugin = "@harness-remote/dsh-realtime-voice";
			style.dataset.pluginCss = styleId;
			style.textContent = css;
			document.head.appendChild(style);
		}
		var voice_module_css_default = {
			"callButton": "_77KAyq_callButton",
			"overlayHeader": "_77KAyq_overlayHeader",
			"controls": "_77KAyq_controls",
			"inlineError": "_77KAyq_inlineError",
			"overlay": "_77KAyq_overlay",
			"overlayError": "_77KAyq_overlayError",
			"stopGlyph": "_77KAyq_stopGlyph",
			"secondaryButton": "_77KAyq_secondaryButton",
			"phaseLine": "_77KAyq_phaseLine",
			"liveDot": "_77KAyq_liveDot",
			"agentState": "_77KAyq_agentState",
			"assistantText": "_77KAyq_assistantText",
			"userText": "_77KAyq_userText",
			"endButton": "_77KAyq_endButton",
			"icon": "_77KAyq_icon",
			"errorText": "_77KAyq_errorText",
			"callButtonActive": "_77KAyq_callButtonActive",
			"eyebrow": "_77KAyq_eyebrow",
			"transcripts": "_77KAyq_transcripts"
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
				children: active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: voice_module_css_default.stopGlyph }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VoiceGlyph, {})
			});
		}
		function VoiceGlyph() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 24 24",
				"aria-hidden": "true",
				className: voice_module_css_default.icon,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 3.25a3 3 0 0 0-3 3v5.5a3 3 0 0 0 6 0v-5.5a3 3 0 0 0-3-3Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.75 10.75v1a5.25 5.25 0 0 0 10.5 0v-1M12 17v3.25M9.25 20.25h5.5" })]
			});
		}
		//#endregion
		//#region src/client/VoiceOverlay.tsx
		/** Frame-wide call surface that remains visible while the user changes DSH sessions. */
		function VoiceOverlay({ useVoice, end, toggleMute, cancelResponse, openSession }) {
			const voice = useVoice((snapshot) => snapshot);
			if (voice.phase === "idle") return null;
			if (voice.phase === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${voice_module_css_default.overlay} ${voice_module_css_default.overlayError}`,
				role: "alert",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: voice_module_css_default.errorText,
					children: voice.error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: voice_module_css_default.secondaryButton,
					onClick: () => void end(),
					children: "关闭"
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: voice_module_css_default.overlay,
				"aria-label": "实时语音通话",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: voice_module_css_default.overlayHeader,
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
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: voice_module_css_default.agentState,
							children: voice.agentRunning ? "Agent 工作中" : "Agent 待命"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.transcripts,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.userText,
							children: voice.userTranscript || "正在聆听…"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.assistantText,
							children: voice.assistantTranscript || "你可以直接交代任务、追问进度或随时纠正方向。"
						})]
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
								children: "打断播报"
							}),
							voice.sessionId === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
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
				]
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
		//#region src/client/index.ts
		const inject = ["slots", "sessions"];
		/** Register one composer action and one frame overlay; both disappear with this client fiber. */
		function apply(ctx) {
			const voice = new VoiceCallController();
			ctx.effect(() => async () => voice.dispose(), "realtime-voice: browser media lifecycle");
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
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map