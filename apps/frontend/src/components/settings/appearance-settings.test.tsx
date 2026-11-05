import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import * as contextsModule from "@/contexts"
import { AppearanceSettings } from "./appearance-settings"

afterEach(() => vi.restoreAllMocks())

function mount(timeFormat: "12h" | "24h") {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { theme: "system", messageDisplay: "compact", timeFormat },
    updatePreference: vi.fn(),
    updateAccessibility: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  render(<AppearanceSettings />)
}

describe("AppearanceSettings preview", () => {
  it("renders sample rows with the timeline's classes, hidden from assistive tech, in the viewer's clock", () => {
    mount("12h")

    const preview = screen.getByTestId("appearance-preview")
    expect({
      hidden: preview.getAttribute("aria-hidden"),
      rows: preview.querySelectorAll(".message-item").length,
      avatars: preview.querySelectorAll(".message-avatar").length,
      firstTime: preview.querySelector(".message-content .text-xs")?.textContent,
    }).toEqual({ hidden: "true", rows: 2, avatars: 1, firstTime: "9:41 AM" })
  })

  it("follows the theme controls, so they lead the page on a phone", () => {
    mount("24h")

    const preview = screen.getByTestId("appearance-preview")
    const theme = screen.getByRole("radiogroup", { name: "Theme" })
    expect(theme.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("sits in the Font row's body, inside the text card rather than as a card of its own", () => {
    mount("24h")

    expect(screen.getByTestId("appearance-preview").closest("[data-setting]")?.getAttribute("data-setting")).toBe(
      "font-family"
    )
  })
})
