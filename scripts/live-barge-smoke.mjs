import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'
import {
  AUDIO_CHANNELS,
  AudioFrameKind,
  decodeAudioFrame,
  encodeAudioFrame,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  VOICE_PROTOCOL,
  VOICE_ROUTE,
} from '../lib/protocol.js'

const sessionId = process.env.DSH_SMOKE_SESSION_ID
const firstFile = process.env.DSH_SMOKE_FIRST_PCM
const interruptFile = process.env.DSH_SMOKE_INTERRUPT_PCM
if (!sessionId) throw new Error('Set DSH_SMOKE_SESSION_ID to an existing local DSH session id')
if (!firstFile || !interruptFile) throw new Error('Set DSH_SMOKE_FIRST_PCM and DSH_SMOKE_INTERRUPT_PCM')

const [firstAudio, interruptAudio] = await Promise.all([readFile(firstFile), readFile(interruptFile)])
const baseUrl = process.env.DSH_SMOKE_BASE_URL ?? 'ws://127.0.0.1:3080'
const socket = new WebSocket(new URL(VOICE_ROUTE, baseUrl))
const frameBytes = 40 * INPUT_SAMPLE_RATE * 2 / 1000
const timeout = setTimeout(() => socket.terminate(), 90_000)
let inputSequence = 0
let interruptStartedAt = 0
let bargeInLatencyMs = -1
let playbackClearReason = ''
let interruptStarted = false
let speakingAfterBargeIn = false
let responseFinishedAfterBargeIn = false
let outputAfterBargeIn = 0
let finalUserTurns = 0
let finalAssistantTurns = 0
let completed = false

await new Promise((resolve, reject) => {
  const finish = () => {
    if (completed
      || bargeInLatencyMs < 0
      || outputAfterBargeIn === 0
      || finalUserTurns < 2
      || finalAssistantTurns < 1
      || !responseFinishedAfterBargeIn) return
    completed = true
    socket.send(JSON.stringify({ type: 'voice.end', reason: 'live-barge-smoke-complete' }))
  }

  socket.once('open', () => {
    socket.send(JSON.stringify({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: crypto.randomUUID(),
      client: {
        platform: 'unknown',
        version: 'live-barge-smoke',
        binaryWebSocket: true,
        playbackClear: true,
        pcmS16leVerified: true,
        foregroundOnly: true,
        duplex: 'full',
      },
      target: { sessionId },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: INPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
        output: { encoding: 'pcm_s16le', sampleRate: OUTPUT_SAMPLE_RATE, channels: AUDIO_CHANNELS, frameDurationMs: 40 },
      },
    }))
  })

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = decodeAudioFrame(new Uint8Array(data))
      if (frame.kind !== AudioFrameKind.ServerOutput) return
      if (!interruptStarted) {
        interruptStarted = true
        interruptStartedAt = Date.now()
        // The browser detector used by production confirms two 40ms voiced
        // frames. This fixture contains 240ms of leading silence, so 360ms
        // exercises the same local-cancel-before-cloud-VAD path.
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'voice.cancel-response' }))
          }
        }, 360)
        void streamAudio(socket, interruptAudio, frameBytes).catch(reject)
      } else if (bargeInLatencyMs >= 0) {
        outputAfterBargeIn += 1
        finish()
      }
      return
    }
    const message = JSON.parse(data.toString())
    if (message.type === 'voice.error') {
      reject(new Error(`${message.code}: ${message.message}`))
      return
    }
    if (message.type === 'voice.ready') {
      if (message.provider.turnDetection !== 'server_vad') {
        reject(new Error(`Expected server_vad, received ${message.provider.turnDetection}`))
        return
      }
      void streamAudio(socket, firstAudio, frameBytes).catch(reject)
      return
    }
    if (message.type === 'voice.playback-clear' && bargeInLatencyMs < 0 && interruptStarted) {
      bargeInLatencyMs = Date.now() - interruptStartedAt
      playbackClearReason = message.reason
      return
    }
    if (message.type === 'voice.transcript' && message.final) {
      if (message.role === 'user') finalUserTurns += 1
      else finalAssistantTurns += 1
      finish()
      return
    }
    if (message.type === 'voice.state') {
      if (bargeInLatencyMs >= 0 && message.phase === 'speaking') speakingAfterBargeIn = true
      if (speakingAfterBargeIn && message.phase === 'listening') responseFinishedAfterBargeIn = true
      finish()
      return
    }
    if (message.type === 'voice.ended') resolve()
  })
  socket.once('error', reject)
  socket.once('close', (code, reason) => {
    if (completed && (code === 1000 || code === 1001)) resolve()
    else reject(new Error(`voice socket closed before barge-in completion: ${code} ${reason.toString()}`))
  })
})

clearTimeout(timeout)
if (socket.readyState < WebSocket.CLOSING) socket.close()
console.log(`barge-in playback clear latency: ${bargeInLatencyMs}ms`)
console.log(`playback clear reason: ${playbackClearReason}`)
console.log(`final user turns: ${finalUserTurns}; assistant turns: ${finalAssistantTurns}`)
console.log(`post-barge output frames: ${outputAfterBargeIn}`)
if (bargeInLatencyMs > 1_000) throw new Error(`Local barge-in exceeded 1000ms: ${bargeInLatencyMs}ms`)
if (playbackClearReason !== 'cancelled') throw new Error(`Expected local cancelled clear, received ${playbackClearReason}`)
console.log('live full-duplex barge-in smoke test passed')

async function streamAudio(target, pcm, size) {
  const tail = Buffer.alloc(INPUT_SAMPLE_RATE * 2)
  const stream = Buffer.concat([pcm, tail])
  for (let offset = 0; offset < stream.byteLength; offset += size) {
    const payload = stream.subarray(offset, Math.min(offset + size, stream.byteLength))
    const sequence = inputSequence++
    target.send(encodeAudioFrame(AudioFrameKind.ClientInput, 1, sequence, payload, { ptsMs: sequence * 40 }))
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}
