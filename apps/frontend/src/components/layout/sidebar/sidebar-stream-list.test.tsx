import { act } from "react"
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { fireEvent, render, screen } from "@/test"
import { StreamTypes, Visibilities, MAX_BOARD_SCOPE_STREAMS } from "@threahq/types"
import { SidebarStreamList } from "./sidebar-stream-list"
import type { StreamItemData } from "./types"
import type { SidebarBoardMode } from "./board-sidebar-mode"
import type { ResolvedSection } from "./resolve-sections"
import * as contextsModule from "@/contexts"

function makeStream(id: string): StreamItemData {
  return {
    id,
    workspaceId: "workspace_1",
    type: StreamTypes.CHANNEL,
    displayName: id,
    slug: id,
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-03-03T09:00:00Z",
    updatedAt: "2026-03-03T09:00:00Z",
    archivedAt: null,
    urgency: "activity",
    section: "recent",
    lastMessagePreview: null,
  } as StreamItemData
}

function makeBoardMode(over: Partial<SidebarBoardMode> = {}): SidebarBoardMode {
  return {
    workspaceId: "workspace_1",
    includedStreamIds: new Set<string>(),
    excludedStreamIds: new Set<string>(),
    mutedStreamIds: new Set<string>(),
    focusHref: (id: string) => `/w/workspace_1/board?in=${id}`,
    applyInclude: vi.fn(),
    applyExclude: vi.fn(),
    scopeAllHref: (ids: readonly string[]) => `/w/workspace_1/board?in=${ids.join(",")}`,
    labelFocusHref: (labelId: string) => `/w/workspace_1/board?label=${labelId}`,
    typeFocusHref: (type: string) => `/w/workspace_1/board?is=${type}`,
    unreadFocusHref: () => `/w/workspace_1/board?unread=true`,
    clearAxisHref: (param: string) => `/w/workspace_1/board?cleared=${param}`,
    setMuted: vi.fn(),
    statsForStream: () => null,
    lensTotals: null,
    ...over,
  } as SidebarBoardMode
}

function stubSidebarContexts() {
  vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
    collapseOnMobile: vi.fn(),
    registerOpenMenu: vi.fn(() => () => {}),
  } as unknown as ReturnType<typeof contextsModule.useSidebar>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { keyboardShortcuts: {} },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

function renderList(streams: StreamItemData[], search: string) {
  const section: ResolvedSection = {
    section: {
      id: "custom:sec_1",
      spec: { kind: "custom", sectionId: "sec_1", name: "Reading list", streamIds: streams.map((s) => s.id) },
    },
    items: streams,
  } as unknown as ResolvedSection

  render(
    <MemoryRouter initialEntries={[`/w/workspace_1/board${search}`]}>
      <SidebarStreamList
        workspaceId="workspace_1"
        hasError={false}
        hasUserStreams
        processedStreams={streams}
        resolvedSections={[section]}
        labelsById={new Map()}
        getUnreadCount={() => 0}
        getMentionCount={() => 0}
        getSectionState={() => "open"}
        toggleSectionState={vi.fn()}
        onCreateScratchpad={vi.fn()}
        onCreateChannel={vi.fn()}
        onFileStreamToSection={vi.fn()}
        onAssignStreamLabel={vi.fn()}
        onStreamMovedFromLabel={vi.fn()}
        homeHintFor={() => null}
        boardMode={makeBoardMode()}
        onClearInbox={vi.fn()}
      />
    </MemoryRouter>
  )
}

describe("SidebarStreamList — Scope all over the cap", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubSidebarContexts()
  })

  const oversized = Array.from({ length: MAX_BOARD_SCOPE_STREAMS + 3 }, (_, i) => makeStream(`stream_${i}`))
  const capped = oversized.slice(0, MAX_BOARD_SCOPE_STREAMS).map((s) => s.id)

  it("scopes to the capped id list", () => {
    renderList(oversized, "")

    expect(screen.getByRole("link", { name: /^Scope board to the first/ })).toHaveAttribute(
      "href",
      `/w/workspace_1/board?in=${capped.join(",")}`
    )
  })

  it("reads active (and clears) once the URL holds the capped list, naming the clear", () => {
    renderList(oversized, `?in=${capped.join(",")}`)

    const link = screen.getByRole("link", { name: "Clear board scope Reading list" })
    expect(link).toHaveAttribute("href", "/w/workspace_1/board?cleared=in")
    expect(link).toHaveAttribute("aria-current", "true")
  })

  it("still reads active for a section within the cap", () => {
    const small = [makeStream("stream_a"), makeStream("stream_b")]
    renderList(small, "?in=stream_b,stream_a")

    expect(screen.getByRole("link", { name: "Clear board scope Reading list" })).toHaveAttribute(
      "href",
      "/w/workspace_1/board?cleared=in"
    )
  })
})

describe("SidebarStreamList — quick-jump numbering", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubSidebarContexts()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function customSection(sectionId: string, streams: StreamItemData[]): ResolvedSection {
    return {
      section: {
        id: `custom:${sectionId}`,
        spec: { kind: "custom", sectionId, name: sectionId, streamIds: streams.map((s) => s.id) },
      },
      items: streams,
    } as unknown as ResolvedSection
  }

  function renderSections(
    sections: ResolvedSection[],
    over: { unread?: (streamId: string) => number; sectionState?: (section: string) => string } = {}
  ) {
    const streams = sections.flatMap((s) => s.items)
    render(
      <MemoryRouter initialEntries={["/w/workspace_1"]}>
        <SidebarStreamList
          workspaceId="workspace_1"
          hasError={false}
          hasUserStreams
          processedStreams={streams}
          resolvedSections={sections}
          labelsById={new Map()}
          getUnreadCount={over.unread ?? (() => 0)}
          getMentionCount={() => 0}
          getSectionState={
            ((section: string, defaultState: string) =>
              over.sectionState?.(section) ?? defaultState) as unknown as React.ComponentProps<
              typeof SidebarStreamList
            >["getSectionState"]
          }
          toggleSectionState={vi.fn()}
          onCreateScratchpad={vi.fn()}
          onCreateChannel={vi.fn()}
          onFileStreamToSection={vi.fn()}
          onAssignStreamLabel={vi.fn()}
          onStreamMovedFromLabel={vi.fn()}
          homeHintFor={() => null}
          boardMode={null}
          onClearInbox={vi.fn()}
        />
      </MemoryRouter>
    )
  }

  /** Hold the modifier past the reveal delay, then read the numbered rows in order. */
  function numberedStreamIds(): string[] {
    fireEvent.keyDown(document, { key: "Control", ctrlKey: true })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    return [...document.querySelectorAll<HTMLAnchorElement>("a[aria-keyshortcuts]")]
      .sort(
        (a, b) =>
          Number(a.getAttribute("aria-keyshortcuts")?.split("+").pop()) -
          Number(b.getAttribute("aria-keyshortcuts")?.split("+").pop())
      )
      .map((link) => link.getAttribute("href")?.replace("/w/workspace_1/s/", "") ?? "")
  }

  it("numbers the rendered order, not the section's raw item order", () => {
    const streams = ["stream_a", "stream_b", "stream_c"].map(makeStream)
    renderSections([customSection("sec_1", streams)], { unread: (id) => (id === "stream_c" ? 2 : 0) })

    // The tiered section floats its unread stream to the top, so it is row 1.
    expect(numberedStreamIds()).toEqual(["stream_c", "stream_a", "stream_b"])
  })

  it("skips a collapsed section entirely", () => {
    renderSections(
      [
        customSection("sec_1", [makeStream("stream_a")]),
        customSection("sec_2", [makeStream("stream_b"), makeStream("stream_c")]),
      ],
      { sectionState: (section) => (section === "custom:sec_1" ? "collapsed" : "open") }
    )

    expect(numberedStreamIds()).toEqual(["stream_b", "stream_c"])
  })

  it("stops after nine rows across sections", () => {
    const first = Array.from({ length: 7 }, (_, i) => makeStream(`stream_a${i}`))
    const second = Array.from({ length: 5 }, (_, i) => makeStream(`stream_b${i}`))
    renderSections([customSection("sec_1", first), customSection("sec_2", second)])

    expect(numberedStreamIds()).toEqual([...first.map((s) => s.id), "stream_b0", "stream_b1"])
  })
})

describe("SidebarStreamList — Inbox section", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubSidebarContexts()
  })

  function unreadSection(streams: StreamItemData[]): ResolvedSection {
    return {
      section: { id: "unread", spec: { kind: "unread" as const } },
      items: streams,
    } as unknown as ResolvedSection
  }

  function renderInbox(
    streams: StreamItemData[],
    over: { unread?: (streamId: string) => number; onClearInbox?: (streamIds: string[]) => void } = {}
  ) {
    const onClearInbox = over.onClearInbox ?? vi.fn()
    render(
      <MemoryRouter initialEntries={["/w/workspace_1"]}>
        <SidebarStreamList
          workspaceId="workspace_1"
          hasError={false}
          hasUserStreams
          processedStreams={streams}
          resolvedSections={[unreadSection(streams)]}
          labelsById={new Map()}
          getUnreadCount={over.unread ?? (() => 0)}
          getMentionCount={() => 0}
          getSectionState={() => "open"}
          toggleSectionState={vi.fn()}
          onCreateScratchpad={vi.fn()}
          onCreateChannel={vi.fn()}
          onFileStreamToSection={vi.fn()}
          onAssignStreamLabel={vi.fn()}
          onStreamMovedFromLabel={vi.fn()}
          homeHintFor={() => null}
          boardMode={null}
          onClearInbox={onClearInbox}
        />
      </MemoryRouter>
    )
    return onClearInbox
  }

  it("labels the section Inbox with the Inbox icon, muted when empty", () => {
    renderInbox([])
    const header = screen.getByText("Inbox")
    expect(header).toBeInTheDocument()
    expect(header).toHaveClass("text-muted-foreground/50")
    expect(screen.getByText("All caught up")).toBeInTheDocument()
  })

  it("shows the Inbox label at full contrast once it holds rows", () => {
    renderInbox([makeStream("stream_a")], { unread: () => 1 })
    expect(screen.getByText("Inbox")).not.toHaveClass("text-muted-foreground/50")
  })

  it("shows Clear all but not Clear read when no row is held", () => {
    renderInbox([makeStream("stream_a")], { unread: () => 1 })
    expect(screen.getByRole("button", { name: "Clear all 1" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear \d+ read/ })).not.toBeInTheDocument()
  })

  it("shows Clear read alongside Clear all when a row is held", () => {
    const streams = [makeStream("stream_a"), makeStream("stream_b")]
    renderInbox(streams, { unread: (id) => (id === "stream_a" ? 0 : 3) })
    expect(screen.getByRole("button", { name: "Clear 1 read" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear all 2" })).toBeInTheDocument()
  })

  it("clears only held rows when Clear read is clicked", () => {
    const streams = [makeStream("stream_a"), makeStream("stream_b")]
    const onClearInbox = renderInbox(streams, { unread: (id) => (id === "stream_a" ? 0 : 3) })
    fireEvent.click(screen.getByRole("button", { name: "Clear 1 read" }))
    expect(onClearInbox).toHaveBeenCalledWith(["stream_a"])
  })

  it("clears every row when Clear all is clicked", () => {
    const streams = [makeStream("stream_a"), makeStream("stream_b")]
    const onClearInbox = renderInbox(streams, { unread: (id) => (id === "stream_a" ? 0 : 3) })
    fireEvent.click(screen.getByRole("button", { name: "Clear all 2" }))
    expect(onClearInbox).toHaveBeenCalledWith(["stream_a", "stream_b"])
  })

  it("stays behaviorally untouched in board mode aside from the Inbox label rename", () => {
    const streams = [makeStream("stream_a")]
    render(
      <MemoryRouter initialEntries={["/w/workspace_1/board"]}>
        <SidebarStreamList
          workspaceId="workspace_1"
          hasError={false}
          hasUserStreams
          processedStreams={streams}
          resolvedSections={[unreadSection(streams)]}
          labelsById={new Map()}
          getUnreadCount={() => 0}
          getMentionCount={() => 0}
          getSectionState={() => "open"}
          toggleSectionState={vi.fn()}
          onCreateScratchpad={vi.fn()}
          onCreateChannel={vi.fn()}
          onFileStreamToSection={vi.fn()}
          onAssignStreamLabel={vi.fn()}
          onStreamMovedFromLabel={vi.fn()}
          homeHintFor={() => null}
          boardMode={makeBoardMode()}
          onClearInbox={vi.fn()}
        />
      </MemoryRouter>
    )

    // Label rename is the only visible change; a held (unreadCount 0) row in
    // board mode gets none of the Inbox-only chrome.
    expect(screen.getByText("Inbox")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear all \d+/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Clear \d+ read/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear from Inbox" })).not.toBeInTheDocument()
  })
})
