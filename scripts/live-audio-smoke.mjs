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
const pcmFile = process.env.DSH_SMOKE_PCM_FILE
if (!sessionId) throw new Error('Set DSH_SMOKE_SESSION_ID to an existing local DSH session id')
if (!pcmFile) throw new Error('Set DSH_SMOKE_PCM_FILE to raw 16 kHz mono PCM s16le test audio')

const audio = await readFile(pcmFile)
if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) throw new Error('Smoke audio is not complete PCM s16le')

const baseUrl = process.env.DSH_SMOKE_BASE_URL ?? 'ws://127.0.0.1:3080'
const socket = new WebSocket(new URL(VOICE_ROUTE, baseUrl))
const frameBytes = 40 * INPUT_SAMPLE_RATE * 2 / 1000
const timeout = setTimeout(() => socket.terminate(), 60_000)
let inputSequence = 0
let outputFrames = 0
let userTranscript = ''
let assistantTranscript = ''
let completed = false
let speakingSeen = false
let responseComplete = false

await new Promise((resolve, reject) => {
  const finish = () => {
    if (completed || !responseComplete || outputFrames === 0 || userTranscript === '') return
    completed = true
    socket.send(JSON.stringify({ type: 'voice.end', reason: 'live-audio-smoke-complete' }))
  }

  socket.once('open', () => {
    socket.send(JSON.stringify({
      type: 'voice.hello',
      protocol: VOICE_PROTOCOL,
      requestId: crypto.randomUUID(),
      client: {
        platform: 'unknown',
        version: 'live-audio-smoke',
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
    if (isBinary) {
      const frame = decodeAudioFrame(new Uint8Array(data))
      if (frame.kind === AudioFrameKind.ServerOutput) outputFrames += 1
      return
    }
    const message = JSON.parse(data.toString())
    if (message.type === 'voice.error') {
      reject(new Error(`${message.code}: ${message.message}`))
      return
    }
    if (message.type === 'voice.ready') {
      console.log(`voice.ready model=${message.provider.model}`)
      void streamAudio(socket, audio, frameBytes).then(() => {
        setTimeout(() => {
          if (outputFrames === 0) socket.send(JSON.stringify({ type: 'voice.commit' }))
        }, 3_000)
      }).catch(reject)
      return
    }
    if (message.type === 'voice.transcript' && message.final) {
      if (message.role === 'user') userTranscript = message.text
      else assistantTranscript = message.text
      finish()
      return
    }
    if (message.type === 'voice.state') {
      if (message.phase === 'speaking') speakingSeen = true
      if (message.phase === 'listening' && speakingSeen) responseComplete = true
      finish()
      return
    }
    if (message.type === 'voice.ended') resolve()
  })
  socket.once('error', reject)
  socket.once('close', (code, reason) => {
    if (completed && (code === 1000 || code === 1001)) resolve()
    else reject(new Error(`voice socket closed before audio completion: ${code} ${reason.toString()}`))
  })
})

clearTimeout(timeout)
if (socket.readyState < WebSocket.CLOSING) socket.close()
console.log(`user transcript: ${userTranscript}`)
console.log(`assistant transcript: ${assistantTranscript || '(audio arrived before final transcript)'}`)
console.log(`server PCM frames: ${outputFrames}`)
console.log('live full audio path smoke test passed')

async function streamAudio(target, pcm, size) {
  const tail = Buffer.alloc(INPUT_SAMPLE_RATE * 2)
  const stream = Buffer.concat([pcm, tail])
  for (let offset = 0; offset < stream.byteLength; offset += size) {
    const payload = stream.subarray(offset, Math.min(offset + size, stream.byteLength))
    if (payload.byteLength % 2 !== 0) throw new Error('PCM frame has a partial sample')
    const sequence = inputSequence++
    target.send(encodeAudioFrame(AudioFrameKind.ClientInput, 1, sequence, payload, { ptsMs: sequence * 40 }))
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}
