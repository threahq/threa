// PCM16 capture worklet for voice dictation.
//
// Runs in the AudioWorkletGlobalScope. Browsers do not reliably honor the
// AudioContext sampleRate hint — iOS Safari in particular forces the hardware
// rate (typically 48kHz) regardless of what we ask for — so this processor
// resamples the mic input down to the 16kHz the upstream STT expects using
// linear interpolation, converts the Float32 [-1,1] samples to little-endian
// 16-bit PCM, and batches them into ~frameMs chunks for the main thread.
class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frameSamples = options?.processorOptions?.frameSamples ?? 1600 // 100ms @ 16kHz
    const targetRate = options?.processorOptions?.targetSampleRate ?? 16000
    this._frameSamples = frameSamples
    this._buffer = new Int16Array(frameSamples)
    this._offset = 0
    // Resampling state. `sampleRate` is this context's real input rate.
    this._ratio = sampleRate / targetRate
    this._t = 0 // next output sample position, in input-sample units since stream start
    this._inIndex = 0 // count of input samples consumed so far
    this._prev = 0 // last input sample of the previous block (virtual index inIndex-1)
  }

  _emit(sample) {
    const s = Math.max(-1, Math.min(1, sample))
    this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff
    if (this._offset === this._frameSamples) {
      // Copy into a fresh ArrayBuffer and transfer ownership to the main thread.
      const frame = this._buffer.slice(0)
      this.port.postMessage(frame.buffer, [frame.buffer])
      this._offset = 0
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channel = input[0]
    if (!channel) return true

    const n = channel.length
    const end = this._inIndex + n

    // Emit each output sample whose interpolation window [i1, i1+1] is fully
    // available given the previous block's last sample plus this block.
    while (this._t < end) {
      const i1 = Math.floor(this._t)
      const i2 = i1 + 1
      if (i2 >= end) break // need the next block's first sample to interpolate
      const frac = this._t - i1
      const s1 = i1 < this._inIndex ? this._prev : channel[i1 - this._inIndex]
      const s2 = i2 < this._inIndex ? this._prev : channel[i2 - this._inIndex]
      this._emit(s1 + (s2 - s1) * frac)
      this._t += this._ratio
    }

    this._inIndex = end
    this._prev = channel[n - 1]
    return true
  }
}

registerProcessor("pcm16-processor", Pcm16Processor)
