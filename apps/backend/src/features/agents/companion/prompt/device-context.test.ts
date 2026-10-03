import { describe, expect, test } from "bun:test"
import { buildDeviceContextSection } from "./device-context"

describe("buildDeviceContextSection", () => {
  test("names the layout, OS and install state", () => {
    expect(buildDeviceContextSection({ layout: "mobile", os: "android", installed: true })).toBe(
      "\n\n## Device\n\nThe person you're replying to was last seen using Threa's mobile layout on Android, as an installed app. When you give directions in the app, give them for that layout."
    )
  })

  test("describes a browser tab on an unrecognised OS without naming an OS", () => {
    expect(buildDeviceContextSection({ layout: "desktop", os: "other", installed: false })).toContain(
      "Threa's desktop layout, in a browser."
    )
  })
})
