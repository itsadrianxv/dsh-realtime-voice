import WebSocket from 'ws'
import {
  AUDIO_CHANNELS,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  VOICE_PROTOCOL,
  VOICE_ROUTE,
} from '../lib/protocol.js'

const sessionId = process.env.DSH_SMOKE_SESSION_ID
if (!sessionId) throw new Error('Set DSH_SMOKE_SESSION_ID to an existing local DSH session id')

const baseUrl = process.env.DSH_SMOKE_BASE_URL ?? 'ws://127.0.0.1:3080'
const socket = new WebSocket(new URL(VOICE_ROUTE, baseUrl))
const timeout = setTimeout(() => socket.terminate(), 30_000)
let ready = false

await new Promise((resolve, reject) => {
  socket.once('open', () => {
    socket.send(JSON.stringify({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: crypto.randomUUID(),
      client: {
        platform: 'unknown',
        version: 'live-smoke',
        binaryWebSocket: true,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: true,
        duplex: 'turn-based',
      },
      target: { sessionId },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: INPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        output: { encoding: 'pcm_s16le', sampleRate: OUTPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
      },
    }))
  })
  socket.on('message', (data, isBinary) => {
    if (isBinary) return
    const message = JSON.parse(data.toString())
    if (message.type === 'voice.error') {
      reject(new Error(`${message.code}: ${message.message}`))
      return
    }
    if (message.type === 'voice.ready') {
      ready = true
      console.log(`voice.ready model=${message.provider.model} vad=${message.provider.turnDetection} session=${message.target.sessionId}`)
      socket.send(JSON.stringify({ type: 'voice.ping', sentAt: 1 }))
      return
    }
    if (message.type === 'voice.pong' && ready) {
      console.log('voice.pong received')
      socket.send(JSON.stringify({ type: 'voice.end', reason: 'live-smoke-complete' }))
      return
    }
    if (message.type === 'voice.ended') resolve()
  })
  socket.once('error', reject)
  socket.once('close', (code, reason) => {
    if (ready && (code === 1000 || code === 1001)) resolve()
    else reject(new Error(`voice socket closed before completion: ${code} ${reason.toString()}`))
  })
})

clearTimeout(timeout)
if (socket.readyState < WebSocket.CLOSING) socket.close()
console.log('live voice Host/provider smoke test passed')
