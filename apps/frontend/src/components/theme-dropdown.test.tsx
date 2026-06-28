import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import { ThemeDropdown } from "./theme-dropdown"
import * as preferencesModule from "@/contexts/preferences-context"
import * as settingsModule from "@/contexts/settings-context"

describe("ThemeDropdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks()

    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { theme: "system" },
      resolvedTheme: "light",
      updatePreference: vi.fn(),
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)

    vi.spyOn(settingsModule, "useSettings").mockReturnValue({
      openSettings: vi.fn(),
    } as unknown as ReturnType<typeof settingsModule.useSettings>)
  })

  // The sidebar host wires onOpenChange to setMenuOpen so the menu opening can't
  // collapse the mobile hover-preview sidebar out from under the open dropdown.
  // Both edges matter: the close report is what lets the sidebar resume
  // collapsing, so a regression that stopped forwarding `false` would strand it.
  it("reports both open and close transitions through onOpenChange", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(<ThemeDropdown onOpenChange={onOpenChange} />)

    await user.click(screen.getByRole("button", { name: "Theme & Settings" }))
    expect(onOpenChange).toHaveBeenCalledWith(true)

    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
