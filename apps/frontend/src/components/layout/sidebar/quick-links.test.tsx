import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { DEFAULT_QUICK_LINKS } from "@threa/types"
import * as Contexts from "@/contexts"
import type { CollapseState } from "@/contexts"
import { SidebarQuickLinks } from "./quick-links"

type SidebarValue = ReturnType<typeof Contexts.useSidebar>

function stubSidebar(quickLinksState: CollapseState = "open"): { toggleSectionState: ReturnType<typeof vi.fn> } {
  const toggleSectionState = vi.fn()
  const value = {
    collapseOnMobile: vi.fn(),
    getSectionState: (section: string, defaultState: CollapseState = "open") =>
      section === "quick-links" ? quickLinksState : defaultState,
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

  it("hides links the viewer has disabled and honors the configured order", () => {
    stubSidebar("open")
    renderQuickLinks({
      quickLinks: [
        { key: "activity", enabled: true },
        { key: "labels", enabled: false },
        { key: "drafts", enabled: true },
      ],
    })

    // Disabled link is gone; the rest render in the order given.
    expect(screen.queryByText("Labels")).not.toBeInTheDocument()
    const rendered = screen.getAllByRole("link").map((l) => l.textContent)
    expect(rendered).toEqual(["Activity", "Drafts"])
  })

  it("renders nothing when every link is hidden", () => {
    stubSidebar("open")
    const { container } = renderQuickLinks({ quickLinks: [{ key: "drafts", enabled: false }] })

    expect(container).toBeEmptyDOMElement()
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
