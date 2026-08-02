import { describe, expect, it } from "bun:test"
import { PERF_CAPTURE_MAX_SAMPLES, performanceCaptureSchema, performanceSampleSchema } from "./performance-capture"

const sample = { name: "bootstrap.tx" as const, at: 1234.5, value: 12 }

function capture(overrides: Record<string, unknown> = {}) {
  return {
    captureId: "cap_01J",
    appVersion: "abc1234",
    deviceClass: "mid" as const,
    startedAt: "2026-08-02T10:00:00.000Z",
    samples: [sample],
    ...overrides,
  }
}

describe("performance capture schema", () => {
  it("rejects a sample with an unknown mark name", () => {
    expect(performanceSampleSchema.safeParse({ name: "bootstrap.unknown", at: 1 }).success).toBe(false)
  })

  it("rejects free-text fields via .strict()", () => {
    expect(performanceSampleSchema.safeParse({ ...sample, streamId: "stream_1" }).success).toBe(false)
    expect(performanceCaptureSchema.safeParse(capture({ userAgent: "Mozilla/5.0" })).success).toBe(false)
  })

  it("rejects a capture over the sample cap", () => {
    const samples = Array.from({ length: PERF_CAPTURE_MAX_SAMPLES + 1 }, () => sample)
    expect(performanceCaptureSchema.safeParse(capture({ samples })).success).toBe(false)
  })

  it("accepts a realistic capture", () => {
    const parsed = performanceCaptureSchema.parse(
      capture({
        samples: [
          sample,
          { name: "observer.longTask", at: 20, value: 78 },
          { name: "liveQuery.rerun", at: 30, count: 1 },
        ],
      })
    )
    expect(parsed.samples).toHaveLength(3)
    expect(parsed.deviceClass).toBe("mid")
  })
})
