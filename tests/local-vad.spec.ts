import { describe, expect, it } from 'vitest'
import { LocalVoiceActivityDetector } from '../src/client/local-vad.ts'

describe('local voice activity onset', () => {
  it('fires after two voiced frames and rearms only after sustained silence', () => {
    const detector = new LocalVoiceActivityDetector()
    const voice = pcm(5_000)
    const silence = pcm(0)

    expect(detector.push(voice)).toBe(false)
    expect(detector.push(voice)).toBe(true)
    expect(detector.push(voice)).toBe(false)
    for (let index = 0; index < 5; index += 1) expect(detector.push(silence)).toBe(false)
    expect(detector.push(voice)).toBe(false)
    expect(detector.push(voice)).toBe(true)
  })

  it('ignores low-level background noise', () => {
    const detector = new LocalVoiceActivityDetector()
    for (let index = 0; index < 20; index += 1) expect(detector.push(pcm(300))).toBe(false)
  })
})

function pcm(amplitude: number): ArrayBuffer {
  const samples = new Int16Array(640)
  samples.fill(amplitude)
  return samples.buffer
}
