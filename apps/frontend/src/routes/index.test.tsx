import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { LegacyMemoRedirect, RootRedirect, WorkspaceHome } from "./index"
import * as useLastLocationModule from "@/hooks/use-last-location"
import * as sidebarContextModule from "@/contexts/sidebar-context"
import { clearLastWorkspaceId, setLastWorkspaceId } from "@/lib/last-workspace"

const mockUseLastLocation = vi.fn()
const mockTogglePinned = vi.fn()

function SearchEcho() {
  const location = useLocation()
  return <div data-testid="search">{location.search}</div>
}

function PathEcho() {
  const location = useLocation()
  return <div data-testid="path">{location.pathname}</div>
}

describe("RootRedirect", () => {
  beforeEach(() => clearLastWorkspaceId())

  it("sends a returning user straight to their last workspace", async () => {
    setLastWorkspaceId("ws_abc")
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/w/:workspaceId" element={<PathEcho />} />
          <Route path="/workspaces" element={<PathEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_abc")
  })

  it("falls back to the workspace picker when no last workspace is recorded", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/w/:workspaceId" element={<PathEcho />} />
          <Route path="/workspaces" element={<PathEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("path")).toHaveTextContent("/workspaces")
  })
})

describe("WorkspaceHome", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockUseLastLocation.mockReset()
    mockTogglePinned.mockReset()
    vi.spyOn(useLastLocationModule, "useLastLocation").mockImplementation(
      (...args) => mockUseLastLocation(...args) as ReturnType<typeof useLastLocationModule.useLastLocation>
    )
    vi.spyOn(sidebarContextModule, "useSidebar").mockReturnValue({
      state: "expanded",
      togglePinned: mockTogglePinned,
    } as unknown as ReturnType<typeof sidebarContextModule.useSidebar>)

    mockUseLastLocation.mockReturnValue({
      redirectStreamId: "stream_123",
      boardHref: null,
      shouldOpenSidebar: false,
      pendingBoardFlag: false,
    })
  })

  it("preserves workspace search params when redirecting to the last stream", async () => {
    render(
      <MemoryRouter initialEntries={["/w/ws_123?ws-settings=bots"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/s/:streamId" element={<SearchEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("search")).toHaveTextContent("?ws-settings=bots")
  })

  it("redirects to the board href when the last surface was the board", async () => {
    mockUseLastLocation.mockReturnValue({
      redirectStreamId: null,
      boardHref: "/w/ws_123/board/active?in=stream_x",
      shouldOpenSidebar: false,
      pendingBoardFlag: false,
    })
    render(
      <MemoryRouter initialEntries={["/w/ws_123"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/board/:lens" element={<PathEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_123/board/active")
  })

  it("renders nothing while the board flag is still unknown", () => {
    mockUseLastLocation.mockReturnValue({
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: false,
      pendingBoardFlag: true,
    })
    render(
      <MemoryRouter initialEntries={["/w/ws_123"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/s/:streamId" element={<SearchEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.queryByText("Select a stream from the sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("search")).not.toBeInTheDocument()
    expect(mockTogglePinned).not.toHaveBeenCalled()
  })

  it("redirects legacy memo routes into the memory explorer", async () => {
    render(
      <MemoryRouter initialEntries={["/w/ws_123/memos/memo_456?q=launch"]}>
        <Routes>
          <Route path="/w/:workspaceId/memos/:memoId" element={<LegacyMemoRedirect />} />
          <Route path="/w/:workspaceId/memory" element={<SearchEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("search")).toHaveTextContent("?q=launch&memo=memo_456")
  })
})
