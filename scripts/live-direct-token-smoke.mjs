import WebSocket from 'ws'

const permanentKey = process.env.DASHSCOPE_API_KEY
if (!permanentKey) {
  console.log('direct media smoke skipped: DASHSCOPE_API_KEY is not available in this shell')
  process.exit(0)
}

const tokenEndpoint = new URL(process.env.DASHSCOPE_TEMPORARY_KEY_ENDPOINT
  ?? 'https://dashscope.aliyuncs.com/api/v1/tokens')
tokenEndpoint.searchParams.set('expire_in_seconds', '60')
const tokenResponse = await fetch(tokenEndpoint, {
  method: 'POST',
  headers: { Authorization: `Bearer ${permanentKey}` },
})
const tokenPayload = await tokenResponse.json().catch(() => ({}))
if (!tokenResponse.ok || typeof tokenPayload.token !== 'string') {
  throw new Error(`temporary key request failed: HTTP ${tokenResponse.status}`)
}

const model = process.env.DASHSCOPE_REALTIME_MODEL ?? 'qwen-audio-3.0-realtime-plus'
const endpoint = new URL(process.env.DASHSCOPE_REALTIME_ENDPOINT
  ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')
endpoint.searchParams.set('model', model)
const socket = new WebSocket(endpoint, {
  headers: {
    Authorization: `Bearer ${tokenPayload.token}`,
    'User-Agent': '@harness-remote/dsh-realtime-voice/direct-smoke',
  },
})

const timeout = setTimeout(() => socket.terminate(), 20_000)
await new Promise((resolve, reject) => {
  socket.once('error', reject)
  socket.once('close', (code, reason) => {
    if (code !== 1000) reject(new Error(`provider closed before session.updated: ${code} ${reason.toString()}`))
  })
  socket.on('message', (raw) => {
    let event
    try { event = JSON.parse(raw.toString()) } catch { return }
    if (event.type === 'session.created') {
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: process.env.DASHSCOPE_REALTIME_VOICE ?? 'longanqian',
          instructions: 'Temporary credential direct-media connectivity smoke test.',
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          max_history_turns: 1,
          tools: [],
          turn_detection: { type: 'server_vad', threshold: 0.35, silence_duration_ms: 500 },
        },
      }))
      return
    }
    if (event.type === 'session.updated') {
      console.log(`direct media smoke passed: temporary key handshake + session.updated (${model})`)
      socket.close(1000, 'direct-smoke-complete')
      resolve()
      return
    }
    if (event.type === 'error') reject(new Error('provider rejected the direct media smoke session'))
  })
})
clearTimeout(timeout)
