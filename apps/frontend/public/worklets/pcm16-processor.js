// PCM16 capture worklet for voice dictation.
//
// Runs in the AudioWorkletGlobalScope. The AudioContext is created at 16kHz, so
// the mic input is already resampled to the rate the upstream STT expects; this
// processor only converts Float32 [-1,1] samples to little-endian 16-bit PCM and
// batches them into ~frameMs chunks before posting them to the main thread.
class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frameSamples = options?.processorOptions?.frameSamples ?? 1600 // 100ms @ 16kHz
    this._frameSamples = frameSamples
    this._buffer = new Int16Array(frameSamples)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channel = input[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this._offset === this._frameSamples) {
        // Copy into a fresh ArrayBuffer and transfer ownership to the main thread.
        const frame = this._buffer.slice(0)
        this.port.postMessage(frame.buffer, [frame.buffer])
        this._offset = 0
      }
    }
    return true
  }
}

registerProcessor("pcm16-processor", Pcm16Processor)
