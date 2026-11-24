import { AUDIO_WAVEFORM_BUCKETS } from "./config"

const WINDOW_CAPACITY = 4096

/**
 * Reduces a stream of mono s16le PCM to per-bucket peaks in constant memory
 * without knowing the total length: samples fold into fixed-count windows, and
 * when the window buffer fills, neighbours merge pairwise and each window
 * doubles in span.
 */
export class PeakReducer {
  private readonly windows = new Uint16Array(WINDOW_CAPACITY)
  private windowCount = 0
  private windowSpan = 1
  private currentPeak = 0
  private currentFill = 0
  private carry: number | null = null
  private samples = 0

  get sampleCount(): number {
    return this.samples
  }

  push(chunk: Uint8Array): void {
    let offset = 0
    if (this.carry !== null && chunk.length > 0) {
      this.addSample(this.carry | (chunk[0]! << 8))
      this.carry = null
      offset = 1
    }
    const end = offset + Math.floor((chunk.length - offset) / 2) * 2
    for (let i = offset; i < end; i += 2) {
      this.addSample(chunk[i]! | (chunk[i + 1]! << 8))
    }
    if (end < chunk.length) this.carry = chunk[end]!
  }

  finish(): Uint8Array {
    if (this.currentFill > 0) this.closeWindow()
    const peaks = new Uint8Array(AUDIO_WAVEFORM_BUCKETS)
    const n = this.windowCount
    if (n === 0) return peaks

    const raw = new Array<number>(AUDIO_WAVEFORM_BUCKETS)
    let loudest = 0
    for (let b = 0; b < AUDIO_WAVEFORM_BUCKETS; b++) {
      const start = Math.floor((b * n) / AUDIO_WAVEFORM_BUCKETS)
      const stop = Math.max(start + 1, Math.floor(((b + 1) * n) / AUDIO_WAVEFORM_BUCKETS))
      let peak = 0
      for (let w = start; w < stop; w++) peak = Math.max(peak, this.windows[w]!)
      raw[b] = peak
      loudest = Math.max(loudest, peak)
    }
    if (loudest === 0) return peaks
    for (let b = 0; b < AUDIO_WAVEFORM_BUCKETS; b++) peaks[b] = Math.round((raw[b]! * 255) / loudest)
    return peaks
  }

  private addSample(unsigned: number): void {
    const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned
    this.samples++
    this.currentPeak = Math.max(this.currentPeak, Math.abs(signed))
    this.currentFill++
    if (this.currentFill === this.windowSpan) this.closeWindow()
  }

  private closeWindow(): void {
    this.windows[this.windowCount++] = this.currentPeak
    this.currentPeak = 0
    this.currentFill = 0
    if (this.windowCount === WINDOW_CAPACITY) this.mergeWindows()
  }

  private mergeWindows(): void {
    const half = WINDOW_CAPACITY / 2
    for (let i = 0; i < half; i++) {
      this.windows[i] = Math.max(this.windows[2 * i]!, this.windows[2 * i + 1]!)
    }
    this.windowCount = half
    this.windowSpan *= 2
  }
}
