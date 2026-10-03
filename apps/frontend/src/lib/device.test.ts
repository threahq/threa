import { describe, it, expect } from "vitest"
import { buildHeartbeatPayload, describeDevice, type DeviceSignals } from "./device"

const DESKTOP_CHROME_ON_LINUX: DeviceSignals = {
  mobileLayout: false,
  installed: false,
  platform: "Linux x86_64",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150",
  maxTouchPoints: 0,
}

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"

describe("describeDevice", () => {
  it("should describe the layout, OS and install state when given an installed Android phone", () => {
    expect(
      describeDevice({
        mobileLayout: true,
        installed: true,
        platform: "Linux armv81",
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36",
        maxTouchPoints: 5,
      })
    ).toEqual({ layout: "mobile", os: "android", installed: true })
  })

  it.each<[string, Partial<DeviceSignals>, string]>([
    ["a Linux desktop", {}, "linux"],
    ["an iPhone", { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, "ios"],
    ["an iPad that claims to be a Mac", { platform: "MacIntel", userAgent: MAC_USER_AGENT, maxTouchPoints: 5 }, "ios"],
    ["a Mac", { platform: "MacIntel", userAgent: MAC_USER_AGENT }, "macos"],
    ["a Chromebook", { userAgent: "Mozilla/5.0 (X11; CrOS x86_64 15000)" }, "chromeos"],
    ["Windows", { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
    ["an unknown platform", { platform: "BeOS", userAgent: "Mozilla/5.0 (Haiku)" }, "other"],
  ])("should report the OS when given %s", (_name, overrides, os) => {
    expect(describeDevice({ ...DESKTOP_CHROME_ON_LINUX, ...overrides }).os).toBe(os)
  })
})

describe("buildHeartbeatPayload", () => {
  it("should carry the device when sharing is on", () => {
    const payload = buildHeartbeatPayload({ focused: true, interacted: true, shareDeviceWithAgents: true })
    expect(payload).toMatchObject({
      focused: true,
      interacted: true,
      device: { layout: expect.stringMatching(/^(mobile|desktop)$/), installed: false },
    })
  })

  it("should leave the device out entirely when sharing is off", () => {
    const payload = buildHeartbeatPayload({ focused: true, interacted: true, shareDeviceWithAgents: false })
    expect(Object.keys(payload).sort()).toEqual(["focused", "interacted", "timezone"])
  })
})
