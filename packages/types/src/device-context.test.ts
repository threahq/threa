import { describe, it, expect } from "bun:test"
import { parseDeviceContext, type DeviceContext } from "./device-context"

describe("parseDeviceContext", () => {
  it("should return the device when it is well-formed", () => {
    const device: DeviceContext = { layout: "mobile", os: "android", installed: true }
    expect(parseDeviceContext(device)).toEqual(device)
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "mobile"],
    ["an unknown layout", { layout: "tablet", os: "ios", installed: true }],
    ["an unknown OS", { layout: "mobile", os: "symbian", installed: true }],
    ["a non-boolean installed", { layout: "mobile", os: "ios", installed: "yes" }],
    ["a missing field", { layout: "mobile", os: "ios" }],
    ["an extra field", { layout: "mobile", os: "ios", installed: true, userAgent: "x" }],
  ])("should reject %s", (_name, value) => {
    expect(parseDeviceContext(value)).toBeNull()
  })
})
