import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, userEvent } from "@/test"
import { getCallPrefs, __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { CallSettings } from "./call-settings"

beforeEach(() => {
  localStorage.clear()
  __resetCallPrefsForTests()
})

describe("CallSettings", () => {
  it("sets the self-mirror pref from the radio", async () => {
    render(<CallSettings />)
    expect(getCallPrefs().selfMirror).toBe("auto")
    await userEvent.click(screen.getByLabelText("Always mirror"))
    expect(getCallPrefs().selfMirror).toBe("on")
    await userEvent.click(screen.getByLabelText("Never mirror"))
    expect(getCallPrefs().selfMirror).toBe("off")
  })

  it("sets the default layout from the radio", async () => {
    render(<CallSettings />)
    await userEvent.click(screen.getByLabelText("Grid"))
    expect(getCallPrefs().layout).toBe("grid")
  })
})
