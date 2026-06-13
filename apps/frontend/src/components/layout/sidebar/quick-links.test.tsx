import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { DEFAULT_QUICK_LINKS } from "@threa/types"
import * as Contexts from "@/contexts"
import type { CollapseState } from "@/contexts"
import { SidebarQuickLinks } from "./quick-links"

type SidebarValue = ReturnType<typeof Contexts.useSidebar>

function stubSidebar(
  quickLinksState: CollapseState = "open",
  moreState: CollapseState = "collapsed"
): { toggleSectionState: ReturnType<typeof vi.fn> } {
  const toggleSectionState = vi.fn()
  const value = {
    collapseOnMobile: vi.fn(),
    getSectionState: (section: string, defaultState: CollapseState = "open") => {
      if (section === "quick-links") return quickLinksState
      if (section === "quick-links:more") return moreState
      return defaultState
    },
    toggleSectionState,
  } as unknown as SidebarValue
  vi.spyOn(Contexts, "useSidebar").mockReturnValue(value)
  return { toggleSectionState }
}

function renderQuickLinks(props: Partial<Parameters<typeof SidebarQuickLinks>[0]> = {}) {
  return render(
    <MemoryRouter>
      <SidebarQuickLinks
        workspaceId="workspace_1"
        quickLinks={DEFAULT_QUICK_LINKS}
        isDraftsPage={false}
        draftCount={0}
        isSavedPage={false}
        savedCount={0}
        isScheduledPage={false}
        scheduledCount={0}
        isActivityPage={false}
        isMemoryPage={false}
        isFilesPage={false}
        isLabelsPage={false}
        unreadActivityCount={0}
        {...props}
      />
    </MemoryRouter>
  )
}

describe("SidebarQuickLinks", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("renders all links when open", () => {
    stubSidebar("open")
    renderQuickLinks()

    expect(screen.getByText("Drafts")).toBeInTheDocument()
    expect(screen.getByText("Files")).toBeInTheDocument()
    expect(screen.getByText("Memory")).toBeInTheDocument()
    expect(screen.getByText("Activity")).toBeInTheDocument()
  })

  it("does not render a Threads quick link", () => {
    stubSidebar("open")
    renderQuickLinks()

    expect(screen.queryByText("Threads")).not.toBeInTheDocument()
  })

  it("hides links the viewer has hidden and honors the configured order", () => {
    stubSidebar("open")
    renderQuickLinks({
      quickLinks: [
        { key: "activity", visibility: "show" },
        { key: "labels", visibility: "hidden" },
        { key: "drafts", visibility: "show" },
      ],
    })

    // Hidden link is gone; the rest render in the order given.
    expect(screen.queryByText("Labels")).not.toBeInTheDocument()
    const rendered = screen.getAllByRole("link").map((l) => l.textContent)
    expect(rendered).toEqual(["Activity", "Drafts"])
  })

  it("renders a 'show when active' link in the main list only when it carries a signal", () => {
    stubSidebar("open")
    // Drafts is "active" — tucked under the collapsed fold with no count, then
    // promoted into the main list once a draft exists.
    const { rerender } = renderQuickLinks({ quickLinks: [{ key: "drafts", visibility: "active" }], draftCount: 0 })
    expect(screen.queryByText("Drafts")).not.toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <SidebarQuickLinks
          workspaceId="workspace_1"
          quickLinks={[{ key: "drafts", visibility: "active" }]}
          isDraftsPage={false}
          draftCount={3}
          isSavedPage={false}
          savedCount={0}
          isScheduledPage={false}
          scheduledCount={0}
          isActivityPage={false}
          isMemoryPage={false}
          isFilesPage={false}
          isLabelsPage={false}
          unreadActivityCount={0}
        />
      </MemoryRouter>
    )
    expect(screen.getByText("Drafts")).toBeInTheDocument()
  })

  it("renders nothing when every link is hidden", () => {
    stubSidebar("open")
    const { container } = renderQuickLinks({ quickLinks: [{ key: "drafts", visibility: "hidden" }] })

    expect(container).toBeEmptyDOMElement()
  })

  it("tucks quiet 'show when active' links under a collapsed 'more' fold", () => {
    stubSidebar("open", "collapsed")
    renderQuickLinks({
      quickLinks: [
        { key: "files", visibility: "show" },
        { key: "drafts", visibility: "active" },
        { key: "saved", visibility: "active" },
      ],
      draftCount: 0,
      savedCount: 0,
    })

    // The always-on link shows; the two quiet ones hide behind the fold.
    expect(screen.getByText("Files")).toBeInTheDocument()
    expect(screen.queryByText("Drafts")).not.toBeInTheDocument()
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /2 more/i })).toBeInTheDocument()
  })

  it("reveals folded links in configured order when the 'more' fold is open", () => {
    stubSidebar("open", "open")
    renderQuickLinks({
      quickLinks: [
        { key: "files", visibility: "show" },
        { key: "saved", visibility: "active" },
        { key: "drafts", visibility: "active" },
      ],
      draftCount: 0,
      savedCount: 0,
    })

    const rendered = screen.getAllByRole("link").map((l) => l.textContent)
    expect(rendered).toEqual(["Files", "Saved", "Drafts"])
    expect(screen.getByRole("button", { name: /less/i })).toBeInTheDocument()
  })

  it("toggles the 'more' fold when its divider is clicked", async () => {
    const user = userEvent.setup()
    const { toggleSectionState } = stubSidebar("open", "collapsed")
    renderQuickLinks({ quickLinks: [{ key: "drafts", visibility: "active" }], draftCount: 0 })

    await user.click(screen.getByRole("button", { name: /1 more/i }))
    expect(toggleSectionState).toHaveBeenCalledWith("quick-links:more", "collapsed")
  })

  it("still renders the section when every link is quiet so links stay reachable", () => {
    stubSidebar("open", "collapsed")
    renderQuickLinks({
      quickLinks: [
        { key: "drafts", visibility: "active" },
        { key: "saved", visibility: "active" },
      ],
      draftCount: 0,
      savedCount: 0,
    })

    // Nothing carries a signal, but the section persists with its fold so the
    // links are one click away instead of disappearing entirely.
    expect(screen.getByText("Quick Links")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /2 more/i })).toBeInTheDocument()
  })

  it("renders only the header when collapsed", () => {
    stubSidebar("collapsed")
    renderQuickLinks({ draftCount: 2, unreadActivityCount: 5 })

    expect(screen.getByText("Quick Links")).toBeInTheDocument()
    expect(screen.queryByText("Drafts")).not.toBeInTheDocument()
    expect(screen.queryByText("Activity")).not.toBeInTheDocument()
  })

  it("shows an aggregate unread badge on the collapsed header when activity is unread", () => {
    stubSidebar("collapsed")
    renderQuickLinks({ unreadActivityCount: 3 })

    // The "3" is rendered inside the aggregate badge on the collapsed header.
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("does not show an aggregate on the collapsed header when nothing is signaling", () => {
    stubSidebar("collapsed")
    renderQuickLinks({ draftCount: 4, savedCount: 7 })

    // Drafts and saved counts are persistent artifacts, not unread signal, so
    // they do not surface on the collapsed header.
    expect(screen.queryByText("4")).not.toBeInTheDocument()
    expect(screen.queryByText("7")).not.toBeInTheDocument()
  })

  it("toggles state when the header is clicked", async () => {
    const user = userEvent.setup()
    const { toggleSectionState } = stubSidebar("open")
    renderQuickLinks()

    await user.click(screen.getByText("Quick Links"))
    expect(toggleSectionState).toHaveBeenCalledTimes(1)
    expect(toggleSectionState).toHaveBeenCalledWith("quick-links", "open")
  })

  it("displays the activity unread badge inline when open", () => {
    stubSidebar("open")
    renderQuickLinks({ unreadActivityCount: 4 })

    expect(screen.getByText("4")).toBeInTheDocument()
  })

  it("displays the draft count inline when open", () => {
    stubSidebar("open")
    renderQuickLinks({ draftCount: 2 })

    expect(screen.getByText("(2)")).toBeInTheDocument()
  })
})
