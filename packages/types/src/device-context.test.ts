import { describe, it, expect } from "bun:test"
import { DEVICE_LAYOUTS, DEVICE_OSES, parseDeviceContext } from "./device-context"

describe("parseDeviceContext", () => {
  it("accepts every layout and OS combination", () => {
    for (const layout of DEVICE_LAYOUTS) {
      for (const os of DEVICE_OSES) {
        expect(parseDeviceContext({ layout, os, installed: false })).toEqual({ layout, os, installed: false })
      }
    }
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
  ])("rejects %s", (_name, value) => {
    expect(parseDeviceContext(value)).toBeNull()
  })
})
