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
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked()
    await userEvent.click(screen.getByLabelText("Always mirror"))
    expect(screen.getByRole("radio", { name: "Always mirror" })).toBeChecked()
    expect(getCallPrefs().selfMirror).toBe("on")
    await userEvent.click(screen.getByLabelText("Never mirror"))
    expect(screen.getByRole("radio", { name: "Never mirror" })).toBeChecked()
    expect(getCallPrefs().selfMirror).toBe("off")
  })

  it("sets the default layout from the radio", async () => {
    render(<CallSettings />)
    await userEvent.click(screen.getByLabelText("Grid"))
    expect(screen.getByRole("radio", { name: "Grid" })).toBeChecked()
    expect(getCallPrefs().layout).toBe("grid")
  })
})
