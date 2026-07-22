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

  it("sets the desktop call surface from the radio, and seeds lastDesktopSurface for an explicit pick", async () => {
    render(<CallSettings />)
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    expect(screen.getByRole("radio", { name: "Keep last" })).toBeChecked()
    await userEvent.click(screen.getByLabelText("Floating square"))
    expect(screen.getByRole("radio", { name: "Floating square" })).toBeChecked()
    expect(getCallPrefs().desktopCallSurface).toBe("floating")
    expect(getCallPrefs().lastDesktopSurface).toBe("floating")
    await userEvent.click(screen.getByLabelText("Sidebar"))
    expect(getCallPrefs().desktopCallSurface).toBe("sidebar")
    // An explicit pick also records "last" so switching to Keep last later resolves to it.
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
    await userEvent.click(screen.getByLabelText("Keep last"))
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    // Keep last must NOT overwrite the remembered surface.
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
  })
})
