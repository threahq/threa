import { describe, expect, test } from "bun:test"
import { PeakReducer } from "./waveform"

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  return bytes
}

function reduce(...chunks: Uint8Array[]): { peaks: number[]; sampleCount: number } {
  const reducer = new PeakReducer()
  for (const chunk of chunks) reducer.push(chunk)
  return { peaks: Array.from(reducer.finish()), sampleCount: reducer.sampleCount }
}

describe("PeakReducer", () => {
  test("should return 200 zero buckets for silence", () => {
    expect(reduce(pcm(new Array(16_000).fill(0)))).toEqual({ peaks: new Array(200).fill(0), sampleCount: 16_000 })
  })

  test("should return 200 zero buckets when no samples arrive", () => {
    expect(reduce()).toEqual({ peaks: new Array(200).fill(0), sampleCount: 0 })
  })

  test("should put a single spike at 255 in the bucket covering its position", () => {
    const samples = new Array(80_000).fill(0)
    samples[50_000] = -12_000

    const expected = new Array(200).fill(0)
    expected[125] = 255
    expect(reduce(pcm(samples))).toEqual({ peaks: expected, sampleCount: 80_000 })
  })

  test("should decode a sample split across chunk boundaries", () => {
    const bytes = pcm([0, 0, 1000, 0, 500, 0])
    const whole = reduce(bytes)

    expect(reduce(bytes.subarray(0, 5), bytes.subarray(5, 9), bytes.subarray(9))).toEqual(whole)
  })

  test("should spread input shorter than 200 samples across all buckets", () => {
    const { peaks } = reduce(pcm([100, -200, 400, 0]))

    expect(peaks).toEqual([
      ...new Array(50).fill(64),
      ...new Array(50).fill(128),
      ...new Array(50).fill(255),
      ...new Array(50).fill(0),
    ])
  })
})
