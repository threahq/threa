import { describe, expect, it, beforeEach, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
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
      />
    </MemoryRouter>
  )
}

describe("SidebarStreamList — Scope all over the cap", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "useSidebar").mockReturnValue({
      collapseOnMobile: vi.fn(),
      setMenuOpen: vi.fn(),
    } as unknown as ReturnType<typeof contextsModule.useSidebar>)
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
