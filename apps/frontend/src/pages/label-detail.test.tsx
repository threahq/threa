import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@/test"
import { Visibilities } from "@threa/types"
import { LabelDetailPage } from "./label-detail"
import { SidebarProvider } from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import type { CachedLabel } from "@/hooks"
import type { CachedStream } from "@/stores/workspace-store"

const WS = "ws_1"
const LABEL_ID = "label_1"

function label(overrides: Partial<CachedLabel> = {}): CachedLabel {
  return {
    id: LABEL_ID,
    workspaceId: WS,
    visibility: Visibilities.PRIVATE,
    creatorUserId: "user_me",
    name: "Reading list",
    slug: "reading-list",
    color: "#3A91C7",
    emoji: "📚",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    _cachedAt: 0,
    ...overrides,
  }
}

function stream(
  id: string,
  displayName: string,
  createdAt: string,
  overrides: Partial<CachedStream> = {}
): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: "scratchpad",
    displayName,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_me",
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    lastMessagePreview: null,
    _cachedAt: 0,
    ...overrides,
  }
}

function renderPage() {
  return render(
    <SidebarProvider>
      <MemoryRouter initialEntries={[`/w/${WS}/labels/${LABEL_ID}`]}>
        <Routes>
          <Route path="/w/:workspaceId/labels/:labelId" element={<LabelDetailPage />} />
        </Routes>
      </MemoryRouter>
    </SidebarProvider>
  )
}

describe("LabelDetailPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Settled fetch by default — the loading/settling path is exercised explicitly below.
    vi.spyOn(hooksModule, "useLabelsSync").mockReturnValue({ isFetched: true } as unknown as ReturnType<
      typeof hooksModule.useLabelsSync
    >)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabels").mockReturnValue([label()] as unknown as ReturnType<
      typeof workspaceStoreModule.useWorkspaceLabels
    >)
  })

  it("lists the streams in the label, newest activity first, with a count", () => {
    vi.spyOn(hooksModule, "useLabelStreams").mockReturnValue([
      stream("stream_new", "Newer note", "2026-03-01T00:00:00.000Z"),
      stream("stream_old", "Older note", "2026-01-01T00:00:00.000Z"),
    ])

    renderPage()

    expect(screen.getByRole("heading", { name: "Reading list", level: 2 })).toBeInTheDocument()
    // Exact href order so a sort-order regression fails the test (not just presence).
    const links = screen.getAllByRole("link", { name: /note/ })
    expect(links.map((l) => l.getAttribute("href"))).toEqual([`/w/${WS}/s/stream_new`, `/w/${WS}/s/stream_old`])
    // Stream count is summarized in the hero meta.
    expect(screen.getByText("2 streams")).toBeInTheDocument()
  })

  it("singularizes the count for one stream", () => {
    vi.spyOn(hooksModule, "useLabelStreams").mockReturnValue([
      stream("stream_one", "Only note", "2026-03-01T00:00:00.000Z"),
    ])

    renderPage()

    expect(screen.getByText("1 stream")).toBeInTheDocument()
  })

  it("shows an empty state when the label has no streams", () => {
    vi.spyOn(hooksModule, "useLabelStreams").mockReturnValue([])

    renderPage()

    expect(screen.getByText("Nothing here yet")).toBeInTheDocument()
    expect(screen.getByText("No streams yet")).toBeInTheDocument()
  })

  it("shows a not-found state when the label is unknown or archived and the fetch has settled", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabels").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabels>
    )
    vi.spyOn(hooksModule, "useLabelStreams").mockReturnValue([])

    renderPage()

    expect(screen.getByText("Label not found")).toBeInTheDocument()
  })

  it("does not flash not-found while the labels fetch is still settling (cold deep-link)", () => {
    // Empty cache + unsettled fetch = bootstrap hasn't landed yet, not "absent".
    vi.spyOn(hooksModule, "useLabelsSync").mockReturnValue({ isFetched: false } as unknown as ReturnType<
      typeof hooksModule.useLabelsSync
    >)
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabels").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabels>
    )
    vi.spyOn(hooksModule, "useLabelStreams").mockReturnValue([])

    renderPage()

    expect(screen.queryByText("Label not found")).not.toBeInTheDocument()
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument()
  })
})
