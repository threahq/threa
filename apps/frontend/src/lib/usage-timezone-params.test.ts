import { describe, expect, it } from "vitest"
import {
  USAGE_ZONE_PARAM,
  parseUsageTimezoneMode,
  writeUsageTimezoneMode,
  type UsageTimezoneMode,
} from "./usage-timezone-params"

describe("parseUsageTimezoneMode", () => {
  it("reads a known mode", () => {
    expect(parseUsageTimezoneMode("workspace")).toBe("workspace")
    expect(parseUsageTimezoneMode("device")).toBe("device")
  })

  it("falls back to device for an absent or unknown value", () => {
    expect(parseUsageTimezoneMode(null)).toBe("device")
    expect(parseUsageTimezoneMode("")).toBe("device")
    expect(parseUsageTimezoneMode("Europe/Stockholm")).toBe("device")
  })
})

describe("writeUsageTimezoneMode", () => {
  it("drops the param for the default mode rather than writing ?zone=device", () => {
    const params = writeUsageTimezoneMode(new URLSearchParams(`${USAGE_ZONE_PARAM}=workspace`), "device")
    expect(params.has(USAGE_ZONE_PARAM)).toBe(false)
  })

  it("writes a non-default mode", () => {
    const params = writeUsageTimezoneMode(new URLSearchParams(), "workspace")
    expect(params.get(USAGE_ZONE_PARAM)).toBe("workspace")
  })

  it("preserves unrelated params", () => {
    const params = writeUsageTimezoneMode(new URLSearchParams("ws-settings=general&foo=1"), "workspace")
    expect(params.get("ws-settings")).toBe("general")
    expect(params.get("foo")).toBe("1")
  })

  it("round-trips every mode through the URL", () => {
    const modes: UsageTimezoneMode[] = ["device", "workspace"]
    for (const mode of modes) {
      expect(parseUsageTimezoneMode(writeUsageTimezoneMode(new URLSearchParams(), mode).get(USAGE_ZONE_PARAM))).toBe(
        mode
      )
    }
  })
})
