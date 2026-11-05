import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import { SettingsProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as preferencesModule from "@/contexts/preferences-context"
import { ComposerSendHint, ComposerSettingsButton } from "./composer-settings-link"

afterEach(() => vi.restoreAllMocks())

describe("ComposerSettingsButton", () => {
  it("links to the send key setting", () => {
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <TooltipProvider>
            <ComposerSettingsButton />
          </TooltipProvider>
        </SettingsProvider>
      </MemoryRouter>
    )

    expect(screen.getByRole("link", { name: "Composer settings" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?settings=keyboard&setting=send-key"
    )
  })

  it("lands on the send button side when Send sits on the left", () => {
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockReturnValue({
      preferences: { accessibility: { composerActionSide: "left" } },
    } as unknown as ReturnType<typeof preferencesModule.usePreferencesOptional>)
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <ComposerSettingsButton />
        </SettingsProvider>
      </MemoryRouter>
    )

    expect(screen.getByRole("link", { name: "Composer settings" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?settings=keyboard&setting=send-side"
    )
  })

  it("renders nothing outside the workspace shell", () => {
    render(
      <TooltipProvider>
        <ComposerSettingsButton />
      </TooltipProvider>
    )

    expect(screen.queryByRole("link", { name: "Composer settings" })).toBeNull()
  })
})

describe("ComposerSendHint", () => {
  it("links the send hint to the send key setting", () => {
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <TooltipProvider>
            <ComposerSendHint hint="⌘Enter to send" />
          </TooltipProvider>
        </SettingsProvider>
      </MemoryRouter>
    )

    expect(screen.getByRole("link", { name: "⌘Enter to send, change send key" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?settings=keyboard&setting=send-key"
    )
  })

  it("stays plain text outside the workspace shell", () => {
    render(
      <TooltipProvider>
        <ComposerSendHint hint="⌘Enter to send" />
      </TooltipProvider>
    )

    expect({ link: screen.queryByRole("link"), text: screen.getByText("⌘Enter to send").tagName }).toEqual({
      link: null,
      text: "SPAN",
    })
  })
})
