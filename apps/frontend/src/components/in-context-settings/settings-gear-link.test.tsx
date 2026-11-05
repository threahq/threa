import { describe, expect, it } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import { SettingsProvider } from "@/contexts"
import { SettingsGearLink } from "./settings-gear-link"

describe("SettingsGearLink", () => {
  it("is a named link to the setting, with a tooltip and a hidden icon", () => {
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <SettingsGearLink setting="message-collapse" label="Long message settings" />
        </SettingsProvider>
      </MemoryRouter>
    )

    const link = screen.getByRole("link", { name: "Long message settings" })
    expect({
      href: link.getAttribute("href"),
      title: link.getAttribute("title"),
      iconHidden: link.querySelector("svg")?.getAttribute("aria-hidden"),
    }).toEqual({
      href: "/w/ws_1/s/stream_1?settings=messages&setting=message-collapse",
      title: "Long message settings",
      iconHidden: "true",
    })
  })

  it("renders nothing outside the workspace shell", () => {
    render(<SettingsGearLink setting="message-collapse" label="Long message settings" />)

    expect(screen.queryByRole("link")).toBeNull()
  })
})
