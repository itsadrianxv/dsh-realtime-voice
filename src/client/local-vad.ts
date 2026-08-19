export interface LocalVadOptions {
  rmsThreshold: number
  peakThreshold: number
  attackFrames: number
  releaseFrames: number
}

const DEFAULT_OPTIONS: LocalVadOptions = {
  rmsThreshold: 0.025,
  peakThreshold: 0.1,
  attackFrames: 2,
  releaseFrames: 5,
}

/** Small browser-side onset detector used only to stop playback before the cloud VAD round trip. */
export class LocalVoiceActivityDetector {
  private hotFrames = 0
  private quietFrames = 0
  private active = false

  constructor(private readonly options: LocalVadOptions = DEFAULT_OPTIONS) {}

  push(pcm: ArrayBuffer): boolean {
    const samples = new Int16Array(pcm)
    if (samples.length === 0) return false
    let energy = 0
    let peak = 0
    for (const value of samples) {
      const normalized = Math.abs(value) / 32768
      energy += normalized * normalized
      peak = Math.max(peak, normalized)
    }
    const rms = Math.sqrt(energy / samples.length)
    const voiced = rms >= this.options.rmsThreshold && peak >= this.options.peakThreshold
    if (voiced) {
      this.quietFrames = 0
      this.hotFrames += 1
      if (!this.active && this.hotFrames >= this.options.attackFrames) {
        this.active = true
        return true
      }
      return false
    }
    this.hotFrames = 0
    if (!this.active) return false
    this.quietFrames += 1
    if (this.quietFrames >= this.options.releaseFrames) {
      this.active = false
      this.quietFrames = 0
    }
    return false
  }

  reset(): void {
    this.hotFrames = 0
    this.quietFrames = 0
    this.active = false
  }
}
