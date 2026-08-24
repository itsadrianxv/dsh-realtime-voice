# DSH Direct Media Protocol v1

`dsh.voice.direct.v1` separates DSH's authoritative control plane from the realtime media plane. It is an independent protocol, not a reinterpretation of `dsh.voice.v1` binary audio frames.

## Endpoints and trust boundary

- Control WebSocket: `/plugins/realtime-voice/v2/control`
- Non-secret occupancy status: `GET /plugins/realtime-voice/v2/status`
- Provider media WebSocket: the `mediaOffer.endpoint` returned by the Host
- Bootstrap schema: `dsh.voice.bootstrap.v1`
- Transcript checkpoint schema: `dsh.voice.transcript.v1`

The DSH Host atomically owns the process-wide voice lease, pins one DSH `sessionId`, issues temporary provider credentials, validates semantic tool calls, executes DSH coordination, and projects authoritative Agent events. The client sends microphone PCM directly to DashScope and plays DashScope PCM directly. A binary frame on the control WebSocket is a fatal `raw-audio-forbidden` error; the Host application never reads, queues, logs, or forwards direct-mode PCM, and the Direct WebSocket parser caps frames at 64 KiB.

The v1 Host-relay route remains available at `/plugins/realtime-voice/v1`. Both modes share the same global lease, so only one caller can own voice at a time, but their media wire formats are isolated.

## Start, lease, and offer

Client:

```json
{
  "type": "voice.hello",
  "protocol": "dsh.voice.direct.v1",
  "requestId": "request-uuid",
  "client": {
    "platform": "wechat-mini-program",
    "version": "1.0.0",
    "foregroundOnly": true,
    "websocketAuthorizationHeader": true
  },
  "target": { "sessionId": "dsh-session-id" }
}
```

Only after the lease and DSH session binding succeed does the Host use its permanent `DASHSCOPE_API_KEY` to request a temporary key. The permanent key never enters a protocol frame, URL, client bundle, or log. The product default TTL is 60 seconds and the plugin caps it at 120 seconds, even though the provider API accepts 1–1,800 seconds. The issuer accepts only official DashScope token hosts and the exact `/api/v1/tokens` path, refuses redirects, and resolves the permanent credential just in time.

Owner response (bearer shortened here only for documentation):

```json
{
  "type": "voice.ready",
  "protocol": "dsh.voice.direct.v1",
  "voiceSessionId": "opaque-resume-capability",
  "serverSeq": 1,
  "target": { "sessionId": "dsh-session-id", "running": false },
  "capabilities": {
    "directMedia": true,
    "reconnect": true,
    "functionBridge": true,
    "backendEventAck": true,
    "rawAudioOnControl": false,
    "transcriptCheckpoint": {
      "version": "dsh.voice.transcript.v1",
      "maxItems": 16,
      "maxTextChars": 4000,
      "maxBytes": 16384,
      "completedTurnsOnly": true
    },
    "resumeRelease": true
  },
  "mediaOffer": {
    "offerId": "offer-uuid",
    "transport": "websocket",
    "endpoint": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    "authorization": {
      "scheme": "Bearer",
      "temporaryBearer": "st-…",
      "expiresAt": 1787550000,
      "authenticationPhase": "handshake-only"
    },
    "model": "qwen-audio-3.0-realtime-plus",
    "voice": "longanqian",
    "audio": {
      "input": {
        "encoding": "pcm_s16le",
        "sampleRate": 16000,
        "channels": 1,
        "recommendedChunkDurationMs": 32
      },
      "output": {
        "encoding": "pcm_s16le",
        "sampleRate": 24000,
        "channels": 1,
        "providerDeltaFraming": "variable"
      }
    },
    "bootstrap": {
      "version": "dsh.voice.bootstrap.v1",
      "event": { "type": "session.update", "session": { "…": "versioned instructions, tools and turn detection" } }
    }
  }
}
```

`recommendedChunkDurationMs: 32` describes only the client's direct `input_audio_buffer.append` cadence (1,024 bytes at 16 kHz/mono/s16le). It is within DashScope's recommended 20–40 ms continuous append range. It does not create Host PCM framing.

A contender receives only `voice.busy` plus non-secret occupancy metadata. The status response's `protocol` always identifies the queried route so existing WebUI validation remains stable; `owner.controlProtocol` may identify whether the active global owner uses relay or Direct mode. Status and busy never contain `voiceSessionId`, offers, bearer tokens, tool receipts, or backend-event content.

DashScope authenticates WSS only during the HTTP upgrade. A healthy established provider socket does not need a token refresh merely because `expiresAt` passes; a later provider reconnect does need a fresh offer. Temporary keys cannot be revoked early, are not guaranteed single-use, and inherit the parent Key's permissions. Production must use a dedicated least-privilege workspace/parent Key restricted to the intended Realtime models. Therefore loss of the control socket immediately removes the Host-side active-media association and prevents tool calls, refresh, and backend delivery, while the client must also close its provider socket. After the bounded 30-second control resume grace, the lease and continuity ledger are deleted.

## Media lifecycle and refresh

After DashScope reports `session.updated`, the client registers the one active provider session:

```json
{ "type": "media.connected", "offerId": "offer-uuid", "mediaSessionId": "provider-session-id", "connectedAt": 1787550000123 }
```

One lease may bind only one active media session. Before replacing it, the client sends:

```json
{ "type": "media.closed", "offerId": "offer-uuid", "mediaSessionId": "provider-session-id", "code": 1006, "reason": "network" }
{ "type": "media.refresh", "previousOfferId": "offer-uuid", "reason": "reconnect" }
```

The Host rate-limits issue requests and uses one continuity-scoped in-flight issuance promise. A control resume shares an already-running issue rather than minting another token, so a stale owner's late HTTP response cannot overwrite the resumed owner's offer. A stale offer id, old owner, second client, active media session, or expired resume capability cannot obtain another credential. `reason: "expiring"` is accepted only near expiry and while no media session is active.

Control clients send `voice.ping` at least every 15 seconds and receive `voice.pong`; 45 seconds without control activity expires a connected lease. Resume uses only the secret previously delivered to the owning socket:

```json
{
  "type": "voice.hello",
  "protocol": "dsh.voice.direct.v1",
  "requestId": "new-request",
  "client": { "platform": "wechat-mini-program", "version": "1.0.0", "foregroundOnly": true, "websocketAuthorizationHeader": true },
  "target": { "sessionId": "dsh-session-id" },
  "resume": { "voiceSessionId": "opaque-resume-capability", "lastServerSeq": 18, "lastBackendEventSeq": 7 }
}
```

The Host atomically validates protocol, platform, bound DSH session, active disconnected lease, grace interval, and sequence watermarks. Public status is never evidence of resume authority. A successful resume returns the same `voiceSessionId` and a new short-lived media offer.

### Transcript continuity across a new provider socket

A control resume preserves Host continuity but necessarily creates a new DashScope Realtime conversation. A client that has collected provider-final text may attach one complete checkpoint to that same resume hello:

```json
{
  "type": "voice.hello",
  "protocol": "dsh.voice.direct.v1",
  "requestId": "new-request",
  "client": { "platform": "wechat-mini-program", "version": "1.1.0", "foregroundOnly": true, "websocketAuthorizationHeader": true },
  "target": { "sessionId": "dsh-session-id" },
  "resume": {
    "voiceSessionId": "opaque-resume-capability",
    "lastServerSeq": 18,
    "lastBackendEventSeq": 7,
    "transcriptCheckpoint": {
      "version": "dsh.voice.transcript.v1",
      "items": [
        { "role": "user", "text": "我们刚才在讨论打印设置。", "final": true },
        { "role": "assistant", "text": "对，已经确认使用彩色双面打印。", "final": true }
      ]
    }
  }
}
```

The checkpoint is accepted only after the resume capability wins the Host's atomic lease arbitration and before a replacement offer is issued. It contains at most 16 items, each text has at most 4,000 JavaScript characters, all text together has at most 16 KiB in UTF-8, and the items must be complete `user, assistant` pairs in chronological order. Only final text is legal: deltas, partial/cancelled responses, system/tool roles, arbitrary metadata, extra keys, odd/unpaired turns, blank text, and over-limit payloads reject the hello. The Host retains the last accepted checkpoint only inside that call's bounded in-memory continuity state; explicit end/release, grace expiry, or plugin disposal deletes it. Omitting the field preserves the prior accepted checkpoint and is backward compatible with existing Direct clients.

The replacement `mediaOffer.bootstrap` then contains a transcript hydration plan alongside the existing `session.update`:

```json
{
  "transcript": {
    "version": "dsh.voice.transcript.v1",
    "applyAfter": "session.updated",
    "acknowledgement": "conversation.item.created",
    "completeBefore": "media.connected",
    "events": [
      {
        "type": "conversation.item.create",
        "item": {
          "id": "dsh_hist_000",
          "type": "message",
          "role": "user",
          "content": [{ "type": "input_text", "text": "我们刚才在讨论打印设置。" }]
        }
      },
      {
        "type": "conversation.item.create",
        "previous_item_id": "dsh_hist_000",
        "item": {
          "id": "dsh_hist_001",
          "type": "message",
          "role": "assistant",
          "content": [{ "type": "output_text", "text": "对，已经确认使用彩色双面打印。" }]
        }
      }
    ]
  }
}
```

The client must send `session.update`, wait for `session.updated`, send these `conversation.item.create` events in order, and wait for the matching `conversation.item.created` for every exact Host-generated item id. Only then may it send `media.connected`, open the microphone, inject backend events, or forward Function Calls. Hydration itself sends no audio and no `response.create`; it must not produce or forward a Function Call. User history uses `input_text`, assistant history uses `output_text`, and `previous_item_id` fixes ordering.

Checkpoint text is authenticated only as low-privilege conversation history supplied by the current lease owner. It is never concatenated into system instructions, a DSH prompt, a Function result, an approval, or the authoritative backend-event ledger. Strings such as `[BACKEND][COMPLETE]`, markup, JSON, or “ignore previous instructions” remain ordinary text in their declared user/assistant item and cannot authorize work or change DSH state. The static bootstrap instruction explicitly preserves this trust boundary.

### Resume and release without a media offer

If the user hangs up while the old control socket is already disconnected, the client opens a control socket and sends the same hello with `"intent": "release"`, the locally held resume tuple, and no transcript checkpoint. `websocketAuthorizationHeader` may be false because this path never opens provider media:

```json
{
  "type": "voice.hello",
  "protocol": "dsh.voice.direct.v1",
  "intent": "release",
  "requestId": "release-request",
  "client": { "platform": "wechat-mini-program", "version": "1.1.0", "foregroundOnly": true, "websocketAuthorizationHeader": false },
  "target": { "sessionId": "dsh-session-id" },
  "resume": { "voiceSessionId": "opaque-resume-capability", "lastServerSeq": 18, "lastBackendEventSeq": 7 }
}
```

The Host atomically releases only an active, disconnected lease whose protocol, platform, DSH `sessionId`, and secret `voiceSessionId` all match and are still inside resume grace. Success returns `voice.ended { reason: "resume-owner-released" }` and makes occupancy inactive immediately. It does not resolve the permanent credential, issue a temporary key, read DSH history, construct an offer, or cancel already-started DSH Agent work. A healthy connected owner, a resumed owner, another protocol/platform/session, a wrong token, and an expired token cannot be released. Absence of `intent` remains the original connect/resume behavior.

## Provider Function Call bridge

DashScope emits Function Calls on the client-owned media socket. The client forwards only the semantic call:

```json
{
  "type": "provider.function-call",
  "offerId": "offer-uuid",
  "mediaSessionId": "provider-session-id",
  "callId": "provider-call-id",
  "name": "handoff_to_dsh_agent",
  "arguments": "{\"instruction\":\"打印最新的读后感\"}"
}
```

The Host verifies the active lease/media tuple, the four-name allow-list, an exact per-tool JSON shape, bounded fields, a 16 KiB arguments limit, and continuity-scoped `callId` idempotency. Concurrent duplicates share one execution; reuse of a `callId` with different content fails. Allowed names are:

- `handoff_to_dsh_agent`
- `cancel_dsh_agent`
- `answer_dsh_approval`
- `answer_dsh_question`

Result:

```json
{
  "type": "provider.function-result",
  "serverSeq": 12,
  "offerId": "offer-uuid",
  "mediaSessionId": "provider-session-id",
  "callId": "provider-call-id",
  "output": { "status": "accepted", "handoff_id": "…", "target_session_id": "…", "mode": "queue" },
  "cached": false
}
```

The client applies a result only when `offerId + mediaSessionId` still match its active provider socket, and writes each tuple plus `callId` at most once. It writes `JSON.stringify(output)` to DashScope as `conversation.item.create` with `item.type: "function_call_output"` and the same `call_id`. When one provider response contains multiple calls, the client uses the response/item grouping already present on its provider socket, writes all outputs, waits for the original response to finish, and sends exactly one subsequent `response.create`. The Host serializes different Function Calls in control-WebSocket arrival order and merges concurrent identical IDs; conflicting reuse revokes the media association instead of producing two outputs. An arbitrary DashScope event is never a trusted DSH instruction. Approval and structured-question cards also remain first-class Host control messages.

If media identity changes while DSH is executing a call, the result is not injected into the new media conversation. DSH work continues and its authoritative status is recorded in the backend-event ledger.

## Backend events and metrics

Host events use stable IDs and monotonic continuity-scoped sequence numbers:

```json
{
  "type": "voice.backend-event",
  "serverSeq": 22,
  "eventId": "dsh:session:event:431:terminal:completed",
  "eventSeq": 8,
  "kind": "complete",
  "text": "[BACKEND][COMPLETE] …"
}
```

The client injects each `eventId` into its current DashScope conversation at most once, then sends `voice.backend-ack`. On control resume, the Host rejects a future `lastBackendEventSeq` and replays every unacknowledged event; the client performs final idempotency by `eventId`. Existing durable history is used only to rebuild current status/summary and is never replayed as a fresh completion. Repeated live projections cannot execute tools and are deduplicated before delivery.

`client.metrics` accepts only non-negative numeric counts/latencies (`capturedFrames`, `playedFrames`, `droppedFrames`, `providerRttMs`, `uplinkJitterMs`, `downlinkJitterMs`). Raw audio, transcripts, arbitrary labels, and unknown metrics are rejected.

## Client support and network domains

DashScope requires an `Authorization: Bearer …` header in the WebSocket upgrade. WeChat `wx.connectSocket`, iOS, Android, Node, and other header-capable clients can implement this protocol. The standard browser `WebSocket` API cannot set that header, so the DSH WebUI continues to use isolated `dsh.voice.v1`; the Host will reject a Direct hello that declares no header capability. The bearer is never moved into a URL to work around this browser restriction.

The plugin route itself is loopback-only and the DSH origin fence is not remote authentication. A Mini Program must reach it only through an authenticated Harness Remote gateway that authorizes the paired user/device and target DSH session; `/v2/control` must never be published as an unauthenticated raw reverse proxy. Production security depends on that gateway enforcing its authenticated principal before forwarding the upgrade.

For a WeChat Mini Program, configure these socket request domains according to the endpoint actually returned by the deployment:

- Recommended workspace endpoint: `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`
- Legacy DashScope endpoint, if used: `wss://dashscope.aliyuncs.com`
- The deployment's authenticated DSH/Harness Remote control WSS origin

Also configure the deployment's HTTPS control/API origin as a request domain when status or bootstrap APIs use HTTPS. Domain entries are an inference from the official endpoints; verify that the production `wx.connectSocket` runtime preserves the Authorization header on a real device before release.

Official references: [temporary API keys](https://help.aliyun.com/zh/model-studio/generate-temporary-api-key), [Realtime token authentication](https://help.aliyun.com/en/model-studio/realtime-token-authentication), [Qwen Audio Realtime](https://help.aliyun.com/zh/model-studio/fun-audiochat-realtime), and [Qwen Audio Realtime client events / history injection](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events).

## Smoke test

With a temporary environment-only key in the current shell:

```powershell
$env:DASHSCOPE_API_KEY = '…'
pnpm build
pnpm smoke:direct
```

The smoke requests a 60-second temporary key, establishes a provider WSS using the Authorization header, sends `session.update`, waits for `session.updated`, records no microphone audio, and never prints either key.
