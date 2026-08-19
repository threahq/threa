import { describe, it, expect } from "vitest"
import { captureErrorText } from "./call-capture-error"

describe("captureErrorText", () => {
  it("should name where the block lives for a no-prompt denial", () => {
    expect(captureErrorText({ code: "capture_failed", kind: "denied" })).toMatch(/site settings/)
    expect(captureErrorText({ code: "capture_failed", kind: "os_denied" })).toMatch(/operating system/)
    expect(captureErrorText({ code: "capture_failed", kind: "blocked_by_policy" })).toMatch(/policy/)
  })

  it("should tell the user another app holds the device when it is busy", () => {
    expect(captureErrorText({ code: "capture_failed", kind: "device_busy" })).toMatch(/Another app or tab/)
  })

  it("should report a missing device distinctly", () => {
    expect(captureErrorText({ code: "capture_failed", kind: "no_device" })).toMatch(/No matching camera/)
  })

  it("should keep the generic copy for an unclassified failure", () => {
    expect(captureErrorText({ code: "capture_failed", kind: "unknown" })).toMatch(/previous device is still active/)
  })

  it("should let a failed rollback trump the taxonomy — rejoin is the only recovery", () => {
    expect(captureErrorText({ code: "capture_rollback_failed", kind: "device_busy" })).toMatch(/leaving and rejoining/)
  })
})
