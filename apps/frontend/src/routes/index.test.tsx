import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom"
import { PanelProvider, usePanel } from "@/contexts/panel-context"
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

function CloseProbe() {
  const { closePanel } = usePanel()
  const location = useLocation()
  return (
    <div>
      <span data-testid="loc">{`${location.pathname}${location.search}`}</span>
      <button onClick={closePanel}>close</button>
    </div>
  )
}

function BackProbe() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <button data-testid="back" onClick={() => navigate(-1)}>
      {`${location.pathname}${location.search}`}
    </button>
  )
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
      exactPath: null,
      redirectStreamId: "stream_123",
      boardHref: null,
      shouldOpenSidebar: false,
    })
  })

  it("restores a fresh exact path verbatim", async () => {
    mockUseLastLocation.mockReturnValue({
      exactPath: "/w/ws_123/board?lens=mine&panel=conv:c_1",
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: false,
    })
    render(
      <MemoryRouter initialEntries={["/w/ws_123"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/board" element={<PathAndSearchEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("path")).toHaveTextContent("/w/ws_123/board?lens=mine&panel=conv:c_1")
  })

  it("restores a panel URL with an entry beneath, so back closes the panel instead of exiting", async () => {
    // The relaunched WebAPK starts with a one-entry history; a plain replace
    // into a `?panel=` URL would make the Android back gesture exit the app
    // (#1666's pop-to-close needs a same-view entry underneath).
    mockUseLastLocation.mockReturnValue({
      exactPath: "/w/ws_123/board?lens=mine&panel=conv:c_1",
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: false,
    })
    render(
      <MemoryRouter initialEntries={["/w/ws_123"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/board" element={<BackProbe />} />
        </Routes>
      </MemoryRouter>
    )

    const probe = await screen.findByTestId("back")
    expect(probe.textContent).toBe("/w/ws_123/board?lens=mine&panel=conv:c_1")
    fireEvent.click(probe)
    await waitFor(() => expect(screen.getByTestId("back").textContent).toBe("/w/ws_123/board?lens=mine"))
  })

  it("closing a restored panel pops the pushed entry, leaving no duplicate", async () => {
    // The two restore hops batch into one commit, so PanelProvider never
    // observes the panel-less entry beneath; the push carries an attestation
    // instead. Without it, close rewrites in place and the first back press
    // after closing is a visual no-op on a duplicate entry.
    mockUseLastLocation.mockReturnValue({
      exactPath: "/w/ws_123/board?lens=mine&panel=conv:c_1",
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: false,
    })
    const router = createMemoryRouter(
      [
        { path: "/elsewhere", element: <PathAndSearchEcho /> },
        { path: "/w/:workspaceId", element: <WorkspaceHome /> },
        {
          path: "/w/:workspaceId/board",
          element: (
            <PanelProvider>
              <CloseProbe />
            </PanelProvider>
          ),
        },
      ],
      { initialEntries: ["/elsewhere", "/w/ws_123"], initialIndex: 1 }
    )
    render(<RouterProvider router={router} />)

    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/w/ws_123/board?lens=mine&panel=conv:c_1"))
    fireEvent.click(screen.getByRole("button", { name: "close" }))
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/w/ws_123/board?lens=mine"))

    // ONE back leaves the restored view entirely: close consumed the pushed
    // panel entry instead of stacking a rewrite on top.
    await act(async () => {
      await router.navigate(-1)
    })
    expect(screen.getByTestId("path").textContent).toBe("/elsewhere")
  })

  it("lets index search params win over the exact path", async () => {
    // `?ws-settings=` and friends must reach the stream redirect, not be
    // swallowed by a verbatim restore.
    mockUseLastLocation.mockReturnValue({
      exactPath: "/w/ws_123/board?lens=mine",
      redirectStreamId: "stream_123",
      boardHref: null,
      shouldOpenSidebar: false,
    })
    render(
      <MemoryRouter initialEntries={["/w/ws_123?ws-settings=bots"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome />} />
          <Route path="/w/:workspaceId/s/:streamId" element={<SearchEcho />} />
          <Route path="/w/:workspaceId/board" element={<PathAndSearchEcho />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByTestId("search")).toHaveTextContent("?ws-settings=bots")
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
