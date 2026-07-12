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

describe("SectionHeader open navigation", () => {
  it("invokes onTitleNavigate (e.g. close the sidebar on mobile) without toggling", async () => {
    const onTitleNavigate = vi.fn()
    const { onToggle } = renderHeader({ titleHref: "/w/ws_1/labels/label_1", onTitleNavigate })

    await userEvent.click(screen.getByRole("link", { name: "Open Reading list" }))

    expect(onTitleNavigate).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

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

describe("SectionHeader accessory", () => {
  it("renders the headerAccessory and keeps its control out of the toggle path", async () => {
    const onClear = vi.fn()
    const { onToggle } = renderHeader({
      headerAccessory: (
        <button type="button" onClick={onClear}>
          Clear read
        </button>
      ),
    })

    await userEvent.click(screen.getByRole("button", { name: "Clear read" }))

    // The accessory's own click fires, but the header must not collapse as a side
    // effect — the right zone stops propagation.
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe("SectionHeader board-mode Scope all", () => {
  it("renders a Scope-all link to the board `?in=` URL, named for the section", () => {
    renderHeader({ label: "Unread", scopeAllHref: "/w/ws_1/board?in=a,b" })

    const link = screen.getByRole("link", { name: "Scope board to Unread streams" })
    expect(link).toHaveAttribute("href", "/w/ws_1/board?in=a,b")
  })

  it("does not toggle the section and collapses on mobile when scoping", async () => {
    const onTitleNavigate = vi.fn()
    const { onToggle } = renderHeader({
      label: "Reading list",
      scopeAllHref: "/w/ws_1/board?in=a",
      onTitleNavigate,
    })

    await userEvent.click(screen.getByRole("link", { name: "Scope board to Reading list streams" }))

    expect(onTitleNavigate).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("renders no Scope-all link in chats mode (no scopeAllHref)", () => {
    renderHeader({ label: "Unread" })
    expect(screen.queryByRole("link", { name: /scope board/i })).not.toBeInTheDocument()
  })
})

describe("SectionHeader label open target", () => {
  it("points the open link at the label page in chats mode", () => {
    renderHeader({ label: "Design", titleContent: "Design", titleHref: "/w/ws_1/labels/label_1" })
    expect(screen.getByRole("link", { name: "Open Design" })).toHaveAttribute("href", "/w/ws_1/labels/label_1")
  })

  it("points the open link at the board label axis in board mode", () => {
    renderHeader({ label: "Design", titleContent: "Design", titleHref: "/w/ws_1/board?label=label_1" })
    expect(screen.getByRole("link", { name: "Open Design" })).toHaveAttribute("href", "/w/ws_1/board?label=label_1")
  })

  it("names the board-mode label affordance for its filter action, not 'Open'", () => {
    renderHeader({
      label: "Design",
      titleContent: "Design",
      titleHref: "/w/ws_1/board?label=label_1",
      titleActionLabel: "Filter board by Design",
    })
    expect(screen.queryByRole("link", { name: "Open Design" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Filter board by Design" })).toHaveAttribute(
      "href",
      "/w/ws_1/board?label=label_1"
    )
  })
})
