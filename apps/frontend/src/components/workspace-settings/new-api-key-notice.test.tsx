import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NewApiKeyNotice } from "./new-api-key-notice"

afterEach(() => vi.restoreAllMocks())

function renderNotice(onDismiss = vi.fn()) {
  render(
    <TooltipProvider>
      <NewApiKeyNotice name="CI pipeline" value="threa_uk_secret" onDismiss={onDismiss} />
    </TooltipProvider>
  )
  return { onDismiss }
}

describe("NewApiKeyNotice", () => {
  it("names its icon buttons, hides the key on request and confirms a copy in place", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    renderNotice()

    expect(screen.getByText("threa_uk_secret")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Hide key" }))
    await user.click(screen.getByRole("button", { name: "Copy key" }))

    expect({
      secret: screen.queryByText("threa_uk_secret"),
      show: screen.queryByRole("button", { name: "Show key" }) !== null,
      copied: screen.queryByRole("button", { name: "Copied" }) !== null,
      clipboard: writeText.mock.calls,
    }).toEqual({ secret: null, show: true, copied: true, clipboard: [["threa_uk_secret"]] })
  })

  it("dismisses", async () => {
    const user = userEvent.setup()
    const { onDismiss } = renderNotice()

    await user.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
