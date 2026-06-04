import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { SectionHeader } from "./sections"

function renderHeader(props: Partial<Parameters<typeof SectionHeader>[0]> = {}) {
  const onToggle = vi.fn()
  render(
    <MemoryRouter>
      <SectionHeader label="Reading list" state="open" onToggle={onToggle} {...props} />
    </MemoryRouter>
  )
  return { onToggle }
}

describe("SectionHeader open link", () => {
  it("renders an open link to titleHref without toggling the section", async () => {
    const { onToggle } = renderHeader({ titleHref: "/w/ws_1/labels/label_1" })

    const link = screen.getByRole("link", { name: "Open Reading list" })
    expect(link).toHaveAttribute("href", "/w/ws_1/labels/label_1")

    // Opening the label must not collapse/expand the section.
    await userEvent.click(link)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("still toggles the section when the header itself is clicked", async () => {
    const { onToggle } = renderHeader({ titleHref: "/w/ws_1/labels/label_1" })

    await userEvent.click(screen.getByRole("button", { name: /collapse reading list/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("renders no open link when titleHref is absent", () => {
    renderHeader()
    expect(screen.queryByRole("link", { name: /open/i })).not.toBeInTheDocument()
  })
})
