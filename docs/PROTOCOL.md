# DSH Voice Protocol v1

`dsh.voice.v1` is the client-neutral boundary between the DSH Host plugin and its user surfaces. WebUI is the first client. A WeChat Mini Program uses the same control messages, binary audio envelope, session pinning, interruption epoch, and DSH tool semantics.

## Transport

- WebSocket path: `/plugins/realtime-voice/v1`
- JSON text frames carry control, transcript, state, tool, and error events.
- Binary frames carry audio with a fixed 24-byte, network-byte-order header. The payload remains codec-native (PCM samples are little-endian).
- Client audio is PCM signed 16-bit little-endian, 16 kHz, mono.
- Server audio is PCM signed 16-bit little-endian, 24 kHz, mono.
- WebSocket ordering is authoritative. `streamId` invalidates audio queued before barge-in or recorder rotation; `sequence`, `ptsMs`, and `payloadLength` support gap detection, jitter buffering, and Mini Program diagnostics.

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

The DSH Host owns one process-wide voice lease. Acquisition happens atomically while handling `voice.hello`, before any DashScope connection is created. A second WebUI or Mini Program client receives `voice.busy` and cannot stream audio. `GET /plugins/realtime-voice/v1/status` exposes only the active client platform, bound DSH session id, voice session id, and timestamps, so every surface can render the same occupancy state. Closing or backgrounding the owning transport releases the lease without cancelling Agent work. A reconnect may replace a stale transport only when it presents the same `voiceSessionId` and the same DSH `sessionId`.

Qwen Audio Realtime is the conversational plane. It answers ordinary conversation itself and invokes a deliberately narrow Function Calling vocabulary only when real execution is required. `handoff_to_dsh_agent` queues work when the pinned DSH session is idle and steers the same turn when it is running. DSH progress and terminal events are tagged and injected back into the Realtime conversation; an accepted handoff is never represented as completed work.

DSH approval and structured-question events are first-class protocol messages:

- Host → client: `voice.approval`, `voice.question`
- Client → Host: `voice.approval-answer`, `voice.question-answer`

The Host answers the original DSH mux `rpcId`; it does not translate the user's choice into a new Agent prompt. A Mini Program can render the same cards as WebUI, while a voice-only client may let Qwen collect the answer and invoke the corresponding semantic function.

## Mini Program boundary

V1 requires a Mini Program client to provide binary WebSocket frames and 16 kHz mono PCM recording. Because WeChat does not document one universal PCM bit layout across every device, a real-device probe must confirm signed 16-bit little-endian samples before the client sends `pcmS16leVerified: true`. The hello capability exchange fails loud if the runtime cannot meet that contract.

Playback uses `wx.createWebAudioContext` (base library 2.19.0 or later) and must discard older stream ids immediately on `voice.playback-clear`. `RecorderManager` has a finite recording duration, so a recorder rotation starts a new `streamId` with the discontinuity flag; the Agent task remains in DSH throughout. Production access requires the existing authenticated remote gateway, a configured WSS request domain, TLS, and the Mini Program network-domain requirements—never a DashScope key in the Mini Program.

V1 is foreground real-time voice. Background/lock-screen continuous recording, guaranteed full duplex on every device, and uniform platform echo cancellation are deliberately not promised. The Mini Program declares `duplex: best-effort` or `turn-based`; on `App.onHide` it may close the voice socket, while the pinned DSH task continues. `App.onShow` reconnects and obtains current task state from DSH. MP3 fallback and additional codecs may be added through a future negotiated protocol version without changing DSH tool semantics.
