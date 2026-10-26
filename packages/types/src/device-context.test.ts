import { describe, it, expect } from "bun:test"
import { parseDeviceContext, type DeviceContext } from "./device-context"

describe("parseDeviceContext", () => {
  it("should return the device when it is well-formed", () => {
    const device: DeviceContext = { layout: "mobile", os: "android", installed: true, openDocIds: ["stream_doc1"] }
    expect(parseDeviceContext(device)).toEqual(device)
  })

  it("should read a report without open docs as having none open", () => {
    expect(parseDeviceContext({ layout: "desktop", os: "linux", installed: false })).toEqual({
      layout: "desktop",
      os: "linux",
      installed: false,
      openDocIds: [],
    })
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "mobile"],
    ["an unknown layout", { layout: "tablet", os: "ios", installed: true }],
    ["an unknown OS", { layout: "mobile", os: "symbian", installed: true }],
    ["a non-boolean installed", { layout: "mobile", os: "ios", installed: "yes" }],
    ["a missing field", { layout: "mobile", os: "ios" }],
    ["a non-string open doc id", { layout: "mobile", os: "ios", installed: true, openDocIds: [1] }],
    ["an over-long open doc id", { layout: "mobile", os: "ios", installed: true, openDocIds: ["x".repeat(65)] }],
    [
      "more than eight open docs",
      { layout: "mobile", os: "ios", installed: true, openDocIds: Array(9).fill("stream_d") },
    ],
    ["an extra field", { layout: "mobile", os: "ios", installed: true, userAgent: "x" }],
  ])("should reject %s", (_name, value) => {
    expect(parseDeviceContext(value)).toBeNull()
  })
})
