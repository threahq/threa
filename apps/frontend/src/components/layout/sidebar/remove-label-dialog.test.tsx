import { describe, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { SettingsProvider } from "@/contexts"
import { RemoveLabelDialog } from "./remove-label-dialog"

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
}

describe("RemoveLabelDialog", () => {
  it("links to the label-move setting and closes on the way there", async () => {
    const onOpenChange = vi.fn()
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <LocationProbe />
          <RemoveLabelDialog
            open
            onOpenChange={onOpenChange}
            labelName="Design"
            streamName="#launch"
            onResolve={vi.fn()}
          />
        </SettingsProvider>
      </MemoryRouter>
    )

    const link = screen.getByRole("link", { name: "Change in settings" })
    expect(link).toHaveAttribute("href", "/w/ws_1/s/stream_1?settings=inbox&setting=label-move")

    await userEvent.click(link)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByTestId("loc")).toHaveTextContent("/w/ws_1/s/stream_1?settings=inbox&setting=label-move")
  })

  it("offers no settings link outside the workspace shell", () => {
    render(
      <RemoveLabelDialog open onOpenChange={vi.fn()} labelName="Design" streamName="#launch" onResolve={vi.fn()} />
    )

    expect(screen.getByRole("button", { name: "Remove label" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Change in settings" })).toBeNull()
  })
})
