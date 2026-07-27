import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AccessibilitySettings } from "./accessibility-settings"
import * as contextsModule from "@/contexts"

const updateAccessibility = vi.fn()

function mountWith(accessibility: unknown) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { accessibility },
    updateAccessibility,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  render(<AccessibilitySettings />)
}

describe("AccessibilitySettings composer action side", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updateAccessibility.mockReset()
  })

  it("writes the chosen side", async () => {
    mountWith({
      reducedMotion: false,
      highContrast: false,
      fontSize: "medium",
      fontFamily: "system",
      composerActionSide: "right",
    })

    await userEvent.click(screen.getByLabelText("Left"))

    expect(updateAccessibility).toHaveBeenCalledWith({ composerActionSide: "left" })
  })

  it("shows the default when a cached preferences blob predates the field", () => {
    // Preferences are read from the IDB cache, so a client that cached before
    // this field shipped has an accessibility object without it. The control
    // must still render its default rather than nothing.
    mountWith({ reducedMotion: false, highContrast: false, fontSize: "medium", fontFamily: "system" })

    expect(screen.getByRole("radio", { name: "Right" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Left" })).not.toBeChecked()
  })
})
