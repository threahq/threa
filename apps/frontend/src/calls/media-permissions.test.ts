import { describe, it, expect } from "vitest"
import { classifyMediaError } from "./media-permissions"

function domError(name: string, message = ""): Error {
  return Object.assign(new Error(message), { name })
}

describe("classifyMediaError", () => {
  it("maps a plain permission denial to denied", () => {
    expect(classifyMediaError(domError("NotAllowedError", "Permission denied")).kind).toBe("denied")
  })

  it("maps a system/OS denial to os_denied", () => {
    expect(classifyMediaError(domError("NotAllowedError", "Permission denied by system")).kind).toBe("os_denied")
  })

  it("maps a permissions-policy block to blocked_by_policy", () => {
    expect(classifyMediaError(domError("NotAllowedError", "disallowed by permissions policy")).kind).toBe(
      "blocked_by_policy"
    )
  })

  it("maps missing hardware to no_device", () => {
    expect(classifyMediaError(domError("NotFoundError")).kind).toBe("no_device")
    expect(classifyMediaError(domError("OverconstrainedError")).kind).toBe("no_device")
  })

  it("maps an in-use device to device_busy", () => {
    expect(classifyMediaError(domError("NotReadableError")).kind).toBe("device_busy")
  })

  it("falls back to unknown", () => {
    expect(classifyMediaError(domError("WeirdError")).kind).toBe("unknown")
  })
})
