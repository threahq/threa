import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, userEvent } from "@/test"
import { getCallPrefs, __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { CallSettings } from "./call-settings"

beforeEach(() => {
  localStorage.clear()
  __resetCallPrefsForTests()
})

async function pickDesktopSurface(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Desktop video" }))
  await userEvent.click(await screen.findByRole("option", { name }))
}

describe("CallSettings", () => {
  it("sets the self-mirror pref", async () => {
    render(<CallSettings />)
    expect(getCallPrefs().selfMirror).toBe("auto")
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked()
    await userEvent.click(screen.getByRole("radio", { name: "Always" }))
    expect(screen.getByRole("radio", { name: "Always" })).toBeChecked()
    expect(getCallPrefs().selfMirror).toBe("on")
    await userEvent.click(screen.getByRole("radio", { name: "Never" }))
    expect(getCallPrefs().selfMirror).toBe("off")
  })

  it("sets the default layout", async () => {
    render(<CallSettings />)
    await userEvent.click(screen.getByRole("radio", { name: "Grid" }))
    expect(screen.getByRole("radio", { name: "Grid" })).toBeChecked()
    expect(getCallPrefs().layout).toBe("grid")
  })

  it("sets the desktop call surface, and seeds lastDesktopSurface for an explicit pick", async () => {
    render(<CallSettings />)
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    expect(screen.getByRole("combobox", { name: "Desktop video" })).toHaveTextContent("Where you left it")
    await pickDesktopSurface("Floating square")
    expect(getCallPrefs().desktopCallSurface).toBe("floating")
    expect(getCallPrefs().lastDesktopSurface).toBe("floating")
    await pickDesktopSurface("Sidebar")
    expect(getCallPrefs().desktopCallSurface).toBe("sidebar")
    // An explicit pick also records "last" so switching to Where you left it later resolves to it.
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
    await pickDesktopSurface("Where you left it")
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    // Where you left it must NOT overwrite the remembered surface.
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
  })

  it("puts layout first and names each control after its setting", () => {
    render(<CallSettings />)
    expect(screen.getAllByRole("radiogroup").map((group) => group.getAttribute("aria-labelledby"))).toEqual([
      "setting-call-layout-label",
      "setting-call-mirror-label",
    ])
    expect(screen.getByRole("combobox", { name: "Desktop video" })).toHaveAttribute(
      "aria-labelledby",
      "setting-call-desktop-video-label"
    )
  })
})
