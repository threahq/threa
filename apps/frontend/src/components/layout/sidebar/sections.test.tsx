import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { SectionHeader, sectionVisibleItems } from "./sections"
import type { StreamItemData } from "./types"

function makeItem(id: string): StreamItemData {
  return { id } as unknown as StreamItemData
}

function renderHeader(props: Partial<Parameters<typeof SectionHeader>[0]> = {}) {
  const onToggle = vi.fn()
  render(
    <MemoryRouter>
      <SectionHeader label="Reading list" state="open" onToggle={onToggle} {...props} />
    </MemoryRouter>
  )
  return { onToggle }
}

describe("sectionVisibleItems", () => {
  const items = ["a", "b", "c"].map(makeItem)
  const noActive = () => false

  it("shows every row and preserves order when the filter is all and the section is not tiered", () => {
    const { visible, hiddenCount } = sectionVisibleItems(items, {
      tiered: false,
      filter: "all",
      moreOpen: false,
      isActive: noActive,
    })
    expect(visible.map((i) => i.id)).toEqual(["a", "b", "c"])
    expect(hiddenCount).toBe(0)
  })

  it("caps a tiered section at the tier limit, keeping active rows past the cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => makeItem(`s${i}`))
    const { visible, hiddenCount } = sectionVisibleItems(many, {
      tiered: true,
      filter: "all",
      moreOpen: false,
      isActive: (id) => id === "s11",
    })
    // First 10 by index, plus the active row past the cap — order preserved.
    expect(visible.map((i) => i.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s11"])
    expect(hiddenCount).toBe(1)
  })

  it("hides quiet rows behind the more count when filtered to unread, preserving order", () => {
    const { visible, hiddenCount } = sectionVisibleItems(items, {
      tiered: false,
      filter: "unread",
      moreOpen: false,
      isActive: (id) => id === "b",
    })
    expect(visible.map((i) => i.id)).toEqual(["b"])
    expect(hiddenCount).toBe(2)
  })

  it("shows every row when moreOpen is true, regardless of filter or tier", () => {
    const { visible, hiddenCount } = sectionVisibleItems(items, {
      tiered: true,
      filter: "unread",
      moreOpen: true,
      isActive: noActive,
    })
    expect(visible.map((i) => i.id)).toEqual(["a", "b", "c"])
    expect(hiddenCount).toBe(0)
  })

  it("never reorders — an active row mid-list stays in place", () => {
    const { visible } = sectionVisibleItems(items, {
      tiered: false,
      filter: "all",
      moreOpen: false,
      isActive: (id) => id === "a",
    })
    expect(visible.map((i) => i.id)).toEqual(["a", "b", "c"])
  })

  describe("thread tree groups", () => {
    const kid = (id: string, parent: string) => ({ id, treeParentId: parent }) as unknown as StreamItemData
    const tree = [makeItem("root"), kid("t_quiet", "root"), kid("t_live", "root"), makeItem("solo")]

    it("should show only active threads and bring their quiet root along as context when filtered to unread", () => {
      const result = sectionVisibleItems(tree, {
        tiered: false,
        filter: "unread",
        moreOpen: false,
        isActive: (id) => id === "t_live",
      })
      expect({
        ids: result.visible.map((i) => i.id),
        hiddenCount: result.hiddenCount,
        context: [...result.contextIds],
      }).toEqual({ ids: ["root", "t_live"], hiddenCount: 2, context: ["root"] })
    })

    it("should keep a root's whole group together when the root is within the tier limit", () => {
      const result = sectionVisibleItems(tree, { tiered: true, filter: "all", moreOpen: false, isActive: () => false })
      expect(result.visible.map((i) => i.id)).toEqual(["root", "t_quiet", "t_live", "solo"])
    })

    it("should surface an active thread past the tier limit with its root as context", () => {
      const filler = Array.from({ length: 10 }, (_, i) => makeItem(`f${i}`))
      const result = sectionVisibleItems([...filler, ...tree], {
        tiered: true,
        filter: "all",
        moreOpen: false,
        isActive: (id) => id === "t_live",
      })
      expect({ ids: result.visible.slice(10).map((i) => i.id), context: [...result.contextIds] }).toEqual({
        ids: ["root", "t_live"],
        context: ["root"],
      })
    })
  })
})

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

describe("SectionHeader board-mode filter affordance", () => {
  it("keeps the affordance visible (not hover-revealed) and uses the filter icon in board mode", () => {
    renderHeader({
      label: "Channels",
      titleHref: "/w/ws_1/board?is=channel",
      titleActionLabel: "Filter board by Channels",
      filterAffordance: true,
    })

    const link = screen.getByRole("link", { name: "Filter board by Channels" })
    expect(link.className).not.toContain("reveal-actions")
    expect(link.className).toContain("opacity-60")
    // The affordance filters, so it must not read as "navigate away".
    expect(link.querySelector("svg")).toHaveClass("lucide-list-filter")
  })

  it("keeps the chats-mode affordance hover-revealed with the navigate icon", () => {
    renderHeader({ label: "Design", titleHref: "/w/ws_1/labels/label_1" })

    const link = screen.getByRole("link", { name: "Open Design" })
    expect(link.className).toContain("reveal-actions")
    expect(link.querySelector("svg")).toHaveClass("lucide-arrow-up-right")
  })

  it("tints the active filter and points it at the clearing URL", () => {
    renderHeader({
      label: "Design",
      titleHref: "/w/ws_1/board?lens=all",
      titleActionLabel: "Clear board filter Design",
      filterAffordance: true,
      filterActive: true,
    })

    const link = screen.getByRole("link", { name: "Clear board filter Design" })
    expect(link).toHaveAttribute("href", "/w/ws_1/board?lens=all")
    expect(link).toHaveAttribute("aria-current", "true")
    expect(link.className).toContain("bg-primary/10")
  })

  it("names the Scope-all cap when the section holds more streams than the scope carries", () => {
    renderHeader({
      label: "Reading list",
      scopeAllHref: "/w/ws_1/board?in=a,b",
      scopeAllTitle: "Scope board to the first 50 of 73 streams",
      filterAffordance: true,
    })

    expect(screen.getByRole("link", { name: "Scope board to the first 50 of 73 streams" })).toHaveAttribute(
      "href",
      "/w/ws_1/board?in=a,b"
    )
  })
})

describe("SectionHeader stream filter toggle", () => {
  it("renders nothing when onToggleFilter is not provided", () => {
    renderHeader({ label: "Channels" })
    expect(screen.queryByRole("button", { name: /show (unread only|all) in channels/i })).not.toBeInTheDocument()
  })

  it("shows Show unread only when the filter is all (default)", () => {
    renderHeader({ label: "Channels", onToggleFilter: vi.fn() })
    const button = screen.getByRole("button", { name: "Show unread only in Channels" })
    expect(button).toHaveAttribute("aria-pressed", "false")
  })

  it("shows Show all and reads pressed when the filter is unread", () => {
    renderHeader({ label: "Channels", sectionFilter: "unread", onToggleFilter: vi.fn() })
    const button = screen.getByRole("button", { name: "Show all in Channels" })
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("calls onToggleFilter and not onToggle when clicked", async () => {
    const onToggleFilter = vi.fn()
    const { onToggle } = renderHeader({ label: "Channels", onToggleFilter })

    await userEvent.click(screen.getByRole("button", { name: "Show unread only in Channels" }))

    expect(onToggleFilter).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("shows the unread aggregate badge while expanded once filtered to unread", () => {
    renderHeader({ label: "Channels", sectionFilter: "unread", onToggleFilter: vi.fn(), unreadAggregate: 3 })
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("hides the unread aggregate badge while expanded and unfiltered", () => {
    renderHeader({ label: "Channels", unreadAggregate: 3 })
    expect(screen.queryByText("3")).not.toBeInTheDocument()
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
