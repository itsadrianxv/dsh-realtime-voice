# DSH Voice Protocol v1

`dsh.voice.v1` is the client-neutral boundary between the DSH Host plugin and its user surfaces. WebUI is the first client. A WeChat Mini Program uses the same control messages, binary audio envelope, session pinning, interruption epoch, and DSH tool semantics.

## Transport

- WebSocket path: `/plugins/realtime-voice/v1`
- JSON text frames carry control, transcript, state, tool, and error events.
- Binary frames carry audio with a fixed 24-byte, network-byte-order header. The payload remains codec-native (PCM samples are little-endian).
- Client audio is PCM signed 16-bit little-endian, 16 kHz, mono.
- Server audio is PCM signed 16-bit little-endian, 24 kHz, mono.
- The Host echoes the client's declared input `frameDurationMs` in `voice.ready`; V1 does not rewrite a valid 32ms input cadence to 40ms. Server output uses 40ms packets: each normal packet is 1,920 bytes, and one final shorter even-byte packet may carry `end-of-stream` before finalization.
- WebSocket ordering is authoritative. `streamId` invalidates audio queued before barge-in or recorder rotation; `sequence`, `ptsMs`, and `payloadLength` support gap detection and jitter buffering on every client.
- DashScope delta boundaries are not protocol packet boundaries. The Host keeps a response-scoped remainder, emits sequence/PTS only for actual outgoing packets, flushes the final complete-sample tail, waits for every WebSocket send callback, and only then sends `voice.playback-finalize`. Cancel, playback clear, disconnect, and disposal invalidate queued packets and discard old remainders.
- Ordinary transport jitter is absorbed by an ordered queue. A queue or socket buffer above 4 MiB, a 15-second binary send timeout, or an upstream DashScope buffer above 4 MiB is an explicit recoverable transport failure; no accepted PCM is silently dropped while the call pretends to remain healthy.

### Binary header

| Offset | Size | Field | V1 value |
|---:|---:|---|---|
| 0 | 4 | magic | ASCII `DSV1` |
| 4 | 1 | version | `1` |
| 5 | 1 | kind | `1` client input, `2` server output |
| 6 | 1 | codec | `1` PCM s16le |
| 7 | 1 | flags | bit 0 discontinuity, bit 1 end-of-stream |
| 8 | 4 | streamId | unsigned integer |
| 12 | 4 | sequence | unsigned integer |
| 16 | 4 | ptsMs | unsigned presentation timestamp |
| 20 | 4 | payloadLength | exact following byte count |

All multi-byte header integers are big-endian. One WebSocket binary message contains exactly one header and one payload, so it maps directly to both browser `ArrayBuffer` and WeChat `SocketTask` binary messages.

## Session semantics

The first client frame is `voice.hello`. It pins the call to one DSH Session id; changing the visible WebUI or Mini Program page never retargets an active call. A disconnected voice socket never cancels the DSH Agent. `voice.hello.resume` may recover the same short-lived call ledger and pending interaction cards; DSH remains the durable task source of truth.

The DSH Host owns one process-wide voice lease. Acquisition happens atomically while handling `voice.hello`, before any DashScope connection is created. A second client receives `voice.busy` and cannot stream audio. `GET /plugins/realtime-voice/v1/status` exposes only non-secret occupancy metadata (active client platform, bound DSH session id, client version, and timestamps); it never exposes a resume capability. The unguessable `voiceSessionId` is returned only to the owning socket in `voice.ready` and is stored locally by that client. A client must not infer resume authority from status: it simply presents its locally held token in `voice.hello.resume`, and only the Host decides atomically whether recovery succeeds. Consequently, `status.active` disables only a fresh dial with no local call context. A client with an active transport or locally held resume context keeps its local owner UI and waits for `voice.ready`, `voice.busy`, or a fatal resume error; presence cannot relabel it as another owner.

An explicit `voice.end` releases the lease and invalidates that call's resume token immediately without cancelling Agent work. An unexpected transport close after `voice.ready` holds a 30-second disconnected grace lease for the owner; during that interval no unrelated client may acquire it. A transport that fails before `voice.ready` is released immediately because no client has received a usable resume token. A healthy connected transport cannot be kicked by a duplicate resume. Recovery requires the same `voiceSessionId`, DSH `sessionId`, and client platform; unknown, cross-session, cross-platform, and future `lastServerSeq` claims are rejected. Clients send `voice.ping` at least every 15 seconds; a connected lease with no audio/control activity for 45 seconds is stale and may be revoked. The Host continuity ledger keeps `serverSeq`, output `streamId`, audio sequence, and PTS monotonic across a valid transport reconnect. The client supplies its last observed `serverSeq` for gap detection and ignores duplicate control frames. Handshake `voice.busy` and fatal errors are always processed even when their provisional transport sequence is lower than the retained call cursor.

Qwen Audio Realtime is the conversational plane. It answers ordinary conversation itself and invokes a deliberately narrow Function Calling vocabulary only when real execution is required. `handoff_to_dsh_agent` queues work when the pinned DSH session is idle and steers the same turn when it is running. Each handoff keeps the exact `sessions.prompt` rpcId and binds only when the matching durable DSH `user/message.source.rpcId` enters a turn, so an unrelated WebUI turn cannot complete voice-owned work. The Host opens the live event stream and folds recent durable history to close provider-connect and reconnect gaps. Cancellation removes only the voice-owned, unclaimed queue item and treats `sessions.cancel` as a request until DSH emits an authoritative terminal event. DSH progress and terminal events are tagged and injected back into the Realtime conversation; an accepted handoff is never represented as completed work.

DSH approval and structured-question events are first-class protocol messages:

- Host → client: `voice.approval`, `voice.question`
- Client → Host: `voice.approval-answer`, `voice.question-answer`

The Host answers the original DSH mux `rpcId`; it does not translate the user's choice into a new Agent prompt. Any visual client can render the same cards, while a voice-only client may let Qwen collect the answer and invoke the corresponding semantic function.

## Duplex and playback capability negotiation

`voice.hello.client.duplex` and `voice.hello.client.echoControl` describe the client audio path, not its platform:

- `full`: the client provides effective acoustic echo cancellation and keeps upstream PCM open during downlink audio.
- `best-effort` or `turn-based` with absent `echoControl` (negotiated as `host-gated`): the Host applies the backward-compatible upstream gate while forwarded downlink audio may still be audible. Local onset detection may stop playback and send `voice.cancel-response`, which immediately clears playback and reopens upstream; late packets from the cancelled provider response are discarded and cannot close the gate again.
- `best-effort` with `echoControl: client-filtered-preroll`: the client has correlated microphone input with its own playback reference, drops pure echo locally, and sends `voice.cancel-response` followed by retained near-end pre-roll PCM on the same ordered WebSocket. This declaration also requires `playbackDrainAck: true`. The Host does not apply a second playback gate, so the first real speech frame after cancel is forwarded to the provider. Pure echo causes no self-interruption because the client uploads neither cancel nor PCM for that path.

Absence of `echoControl` always negotiates to `voice.ready.capabilities.echoControl: host-gated`; existing V1 clients therefore keep their previous bounded behavior. The Host never infers an echo policy from `platform`. WebUI, WeChat, iOS, and Android obtain identical behavior for identical capability declarations.

`voice.hello.client.playbackDrainAck` is an optional V1 capability. Absence means `false`. `voice.ready.capabilities.playbackDrainAck` returns the negotiated value:

- When `true`, after the provider finishes sending one audible response and all its binary PCM sends have completed, the Host emits `voice.playback-finalize { streamId, lastSequence }`. The client waits until its real local player queue for that exact stream is empty, then sends `voice.playback-drained { streamId }`. Only a matching stream can release its gate.
- When absent or `false`, the Host does not send `voice.playback-finalize` and does not require an ACK. It releases the gate after a bounded compatibility interval derived from delivered PCM duration plus a 1.5-second safety margin.
- If a negotiated ACK is lost, the same bounded interval is the safety fallback, so no client can be permanently muted.
- `voice.playback-clear` invalidates all older stream ids immediately. It also cancels any pending drain wait; an ACK for an invalidated stream has no effect.

This is one client-neutral state machine. WebUI, a Mini Program, iOS, Android, and future clients use the same hello/ready/busy/finalize/drained controls, binary header, lease rules, and timeouts. Platform-specific recorder, player, and AEC APIs live only in the corresponding client implementation.

## Mini Program boundary

V1 requires a Mini Program client to provide binary WebSocket frames and 16 kHz mono PCM recording. Because WeChat does not document one universal PCM bit layout across every device, a real-device probe must confirm signed 16-bit little-endian samples before the client sends `pcmS16leVerified: true`. The hello capability exchange fails loud if the runtime cannot meet that contract.

Playback uses `wx.createWebAudioContext` (base library 2.19.0 or later) and implements the shared drain protocol above. The Mini Program declares `playbackDrainAck: true` only when it can observe its actual local player queue; it returns `voice.playback-drained` only after the finalized stream is truly empty. A Mini Program may declare `echoControl: client-filtered-preroll` only when its real-device implementation correlates playback reference audio, suppresses pure echo locally, and preserves the ordered cancel-then-pre-roll sequence. `RecorderManager` has a finite recording duration, so a recorder rotation starts a new input `streamId` with the discontinuity flag; the Agent task remains in DSH throughout. Production access requires the existing authenticated remote gateway, a configured WSS request domain, TLS, and the Mini Program network-domain requirements—never a DashScope key in the Mini Program.

V1 is foreground real-time voice. Background/lock-screen continuous recording, guaranteed full duplex on every device, and uniform platform echo cancellation are deliberately not promised. The Mini Program declares `duplex: best-effort` or `turn-based`; on `App.onHide` it may close the voice socket, while the pinned DSH task continues. `App.onShow` reconnects and obtains current task state from DSH. MP3 fallback and additional codecs may be added through a future negotiated protocol version without changing DSH tool semantics.
