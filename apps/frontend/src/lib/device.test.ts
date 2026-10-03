import { describe, it, expect } from "vitest"
import { buildHeartbeatPayload, describeDevice, type DeviceSignals } from "./device"

const DESKTOP_CHROME_ON_LINUX: DeviceSignals = {
  mobileLayout: false,
  installed: false,
  clientHintPlatform: "Linux",
  platform: "Linux x86_64",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150",
  maxTouchPoints: 0,
}

function signals(overrides: Partial<DeviceSignals>): DeviceSignals {
  return { ...DESKTOP_CHROME_ON_LINUX, ...overrides }
}

describe("describeDevice", () => {
  it("describes a desktop browser tab", () => {
    expect(describeDevice(DESKTOP_CHROME_ON_LINUX)).toEqual({ layout: "desktop", os: "linux", installed: false })
  })

  it("describes an installed Android phone from the client hint, though its UA also says Linux", () => {
    expect(
      describeDevice(
        signals({
          mobileLayout: true,
          installed: true,
          clientHintPlatform: "Android",
          platform: "Linux armv81",
          userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36",
          maxTouchPoints: 5,
        })
      )
    ).toEqual({ layout: "mobile", os: "android", installed: true })
  })

  it("falls back to the user agent for Android without client hints", () => {
    expect(
      describeDevice(
        signals({
          clientHintPlatform: undefined,
          platform: "Linux armv81",
          userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/150 Mobile",
        })
      ).os
    ).toBe("android")
  })

  it("reads an iPad that claims to be a Mac as iOS, and a real Mac as macOS", () => {
    const macUserAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"
    const ipad = signals({
      clientHintPlatform: undefined,
      platform: "MacIntel",
      userAgent: macUserAgent,
      maxTouchPoints: 5,
    })
    expect([describeDevice(ipad).os, describeDevice({ ...ipad, maxTouchPoints: 0 }).os]).toEqual(["ios", "macos"])
  })

  it("reads an iPhone from the user agent", () => {
    expect(
      describeDevice(
        signals({
          mobileLayout: true,
          clientHintPlatform: undefined,
          platform: "iPhone",
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
          maxTouchPoints: 5,
        })
      ).os
    ).toBe("ios")
  })

  it.each([
    ["Windows", "windows"],
    ["macOS", "macos"],
    ["Chrome OS", "chromeos"],
    ["Chromium OS", "chromeos"],
  ])("maps the client hint %s to %s", (clientHintPlatform, os) => {
    expect(describeDevice(signals({ clientHintPlatform })).os).toBe(os)
  })

  it("reads ChromeOS from the user agent when there is no client hint", () => {
    expect(
      describeDevice(
        signals({
          clientHintPlatform: undefined,
          platform: "Linux x86_64",
          userAgent: "Mozilla/5.0 (X11; CrOS x86_64 15000)",
        })
      ).os
    ).toBe("chromeos")
  })

  it("reports other for a platform it does not know", () => {
    expect(
      describeDevice(signals({ clientHintPlatform: "Haiku", platform: "BeOS", userAgent: "Mozilla/5.0 (Haiku)" })).os
    ).toBe("other")
  })
})

describe("buildHeartbeatPayload", () => {
  it("carries the device when sharing is on", () => {
    const payload = buildHeartbeatPayload({ focused: true, interacted: true, shareDeviceWithAgents: true })
    expect(payload).toMatchObject({
      focused: true,
      interacted: true,
      device: { layout: expect.stringMatching(/^(mobile|desktop)$/), installed: false },
    })
  })

  it("leaves the device out entirely when sharing is off", () => {
    const payload = buildHeartbeatPayload({ focused: true, interacted: true, shareDeviceWithAgents: false })
    expect(Object.keys(payload).sort()).toEqual(["focused", "interacted", "timezone"])
  })
})
