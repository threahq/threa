import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { toast } from "sonner"
import type { DelegationSummary } from "@threa/types"
import { DelegationRedirect, LegacyMemoRedirect, RootRedirect, WorkspaceHome } from "./index"
import { ApiError, delegationsApi } from "@/api"
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

function PathAndSearchEcho() {
  const location = useLocation()
  return <div data-testid="path">{`${location.pathname}${location.search}`}</div>
}

function makeDelegationSummary(overrides: Partial<DelegationSummary> = {}): DelegationSummary {
  return {
    id: "deleg_1",
    streamId: "stream_1",
    title: "Ship the thing",
    status: "open",
    claimedByLabel: null,
    resultMessageId: null,
    statusNote: null,
    createdEventId: "event_1",
    createdAt: "2026-07-14T00:00:00.000Z",
    statusChangedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  }
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

describe("DelegationRedirect", () => {
  beforeEach(() => vi.restoreAllMocks())

  function renderRedirect() {
    return render(
      <MemoryRouter initialEntries={["/w/ws_123/delegations/deleg_1"]}>
        <Routes>
          <Route path="/w/:workspaceId/delegations/:delegationId" element={<DelegationRedirect />} />
          <Route path="/w/:workspaceId/s/:streamId" element={<PathAndSearchEcho />} />
          <Route path="/w/:workspaceId" element={<PathAndSearchEcho />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it("deep-links to the card event when the delegation has a created event", async () => {
    vi.spyOn(delegationsApi, "get").mockResolvedValue(
      makeDelegationSummary({ streamId: "stream_9", createdEventId: "event_42" })
    )

    renderRedirect()

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_123/s/stream_9?m=event_42")
  })

  it("navigates to the bare stream when there is no created event id", async () => {
    vi.spyOn(delegationsApi, "get").mockResolvedValue(
      makeDelegationSummary({ streamId: "stream_9", createdEventId: null })
    )

    renderRedirect()

    const path = await screen.findByTestId("path")
    expect(path).toHaveTextContent("/w/ws_123/s/stream_9")
    expect(path.textContent).not.toContain("?m=")
  })

  it("sends the viewer home with a not-found toast on a 404", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "")
    vi.spyOn(delegationsApi, "get").mockRejectedValue(new ApiError(404, "NOT_FOUND", "nope"))

    renderRedirect()

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_123")
    expect(errorSpy).toHaveBeenCalledWith("Delegation not found or not accessible")
  })

  it("sends the viewer home with a generic toast on a non-404 error", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "")
    vi.spyOn(delegationsApi, "get").mockRejectedValue(new ApiError(500, "SERVER_ERROR", "boom"))

    renderRedirect()

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_123")
    expect(errorSpy).toHaveBeenCalledWith("Couldn't open the delegation")
  })
})
