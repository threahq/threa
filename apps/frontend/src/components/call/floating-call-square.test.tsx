import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import {
  clearCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  type CallRosterParticipant,
} from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { CallCaptureError, type CallController } from "@/calls/call-manager"
import { FloatingCallSquare } from "./floating-call-square"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider, useCallLaunch } from "./call-launch-context"

type CachedWorkspaceUser = Parameters<typeof seedWorkspaceCache>[1]["users"][number]

const WORKSPACE_ID = "workspace_1"

function user(overrides: Partial<CachedWorkspaceUser>): CachedWorkspaceUser {
  return {
    id: "usr_x",
    workspaceId: WORKSPACE_ID,
    workosUserId: "workos_x",
    email: "x@example.com",
    role: "member",
    slug: "x",
    name: "X",
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2026-03-01T10:00:00Z",
    _cachedAt: Date.now(),
    ...overrides,
  } as CachedWorkspaceUser
}

function participant(overrides: Partial<CallRosterParticipant>): CallRosterParticipant {
  return {
    userId: "usr_self",
    participantStatus: "joined",
    endpointId: "callep_self",
    connectionStatus: "connected",
    mediaState: {},
    publishedTracks: [],
    ...overrides,
  }
}

function makeManager(overrides: Partial<CallController> = {}): CallController {
  return {
    startCall: vi.fn(async () => {}),
    leaveCall: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setCameraOn: vi.fn(async () => {}),
    switchInputDevice: vi.fn(async () => {}),
    switchCameraDevice: vi.fn(async () => {}),
    flipCamera: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async () => {}),
    getVideoStream: vi.fn(() => null),
    ...overrides,
  }
}

function seedUsers() {
  seedWorkspaceCache(WORKSPACE_ID, {
    workspace: {
      id: WORKSPACE_ID,
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [
      user({ id: "usr_self", workosUserId: "workos_self", slug: "self", name: "Ada" }),
      user({ id: "usr_peer", workosUserId: "workos_peer", slug: "peer", name: "Grace" }),
    ],
    streams: [],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

function renderSquare(manager: CallController = makeManager(), onDockToSide: () => void = vi.fn()) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <FloatingCallSquare workspaceId={WORKSPACE_ID} streamId="stream_1" onSelectSurface={onDockToSide} />
      </CallLaunchProvider>
    </CallManagerProvider>
  )
}

function LaunchButton() {
  const { launch } = useCallLaunch()
  return (
    <button type="button" onClick={() => launch({ workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })}>
      launch
    </button>
  )
}

function renderSquareWithLaunch(manager: CallController) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <LaunchButton />
        <FloatingCallSquare workspaceId={WORKSPACE_ID} streamId="stream_1" onSelectSurface={vi.fn()} />
      </CallLaunchProvider>
    </CallManagerProvider>
  )
}

function enterConnected(roster: CallRosterParticipant[]) {
  act(() => {
    setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })
    setCallPhase("connected")
    setCallRoster(roster, 1)
  })
}

const TWO_PEERS: CallRosterParticipant[] = [
  participant({ userId: "usr_self" }),
  participant({ userId: "usr_peer", endpointId: "callep_peer" }),
]

beforeEach(() => {
  clearCallState()
  resetWorkspaceStoreCache()
  localStorage.clear()
  __resetCallPrefsForTests()
  seedUsers()
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_self" } as ReturnType<typeof authModule.useUser>)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("FloatingCallSquare — connected", () => {
  it("renders one tile per joined participant, Leave, and Dock to the side", () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    const square = screen.getByTestId("floating-call-square")
    expect(square).toHaveAttribute("data-minimized", "false")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    expect(screen.getByLabelText(/Change call view/)).toBeInTheDocument()

    const header = screen.getByTestId("floating-call-square-header")
    expect(header.firstElementChild).toBe(screen.getByTestId("expanded-call-drag-grip"))
    expect(header.lastElementChild).toBe(screen.getByLabelText("Minimize call"))
  })

  it("clicking Dock to the side calls onDockToSide", async () => {
    const onDockToSide = vi.fn()
    renderSquare(makeManager(), onDockToSide)
    enterConnected(TWO_PEERS)
    await act(async () => {
      await userEvent.click(screen.getByLabelText(/Change call view/))
      await userEvent.click(screen.getByRole("menuitemradio", { name: "Sidebar" }))
    })
    expect(onDockToSide).toHaveBeenCalled()
  })

  it("clicking Leave dispatches to the manager", async () => {
    const manager = makeManager()
    renderSquare(manager)
    enterConnected([participant({ userId: "usr_self" })])
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Leave call"))
    })
    expect(manager.leaveCall).toHaveBeenCalled()
  })
})

describe("FloatingCallSquare — minimize / restore", () => {
  it("minimizes at the cursor with persistent call controls, then restores", async () => {
    const manager = makeManager()
    renderSquare(manager)
    enterConnected(TWO_PEERS)
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)

    fireEvent.click(screen.getByLabelText("Minimize call"), { clientX: 500, clientY: 300, detail: 1 })

    const compact = screen.getByTestId("floating-call-square")
    expect(compact).toHaveAttribute("data-minimized", "true")
    expect(compact.style.left).toBe("144px")
    expect(compact.style.top).toBe("275px")
    expect(compact.style.width).toBe("380px")
    expect(screen.getByLabelText("Restore call")).toHaveFocus()
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.getByLabelText("Mute")).toBeInTheDocument()
    expect(screen.getByLabelText("Turn camera on")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    const controls = screen.getByTestId("minimized-call-controls")
    expect(controls).toHaveClass("shrink-0")
    expect(Array.from(controls.children)).toEqual([
      screen.getByLabelText("Mute"),
      screen.getByLabelText("Turn camera on"),
      screen.getByLabelText("Leave call"),
    ])
    expect(screen.queryAllByTestId("call-tile")).toHaveLength(0)

    const compactChildren = Array.from(compact.children)
    expect(compactChildren).toEqual([
      screen.getByTestId("minimized-call-drag-handle"),
      screen.getByTestId("minimized-call-content"),
      screen.getByLabelText(/Change call view/),
      screen.getByLabelText("Restore call"),
    ])
    expect(screen.queryByLabelText("Dock to the side")).toBeNull()

    fireEvent.click(screen.getByLabelText("Mute"))
    expect(manager.setMuted).toHaveBeenCalledWith(true)

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Restore call"))
    })
    expect(screen.getByTestId("floating-call-square")).toHaveAttribute("data-minimized", "false")
    expect(screen.getByLabelText("Minimize call")).toHaveFocus()
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
  })

  it("keeps an hour-long timer and every fixed action in the minimized width", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"))
    renderSquare()
    enterConnected(TWO_PEERS)
    fireEvent.click(screen.getByLabelText("Minimize call"))

    act(() => vi.advanceTimersByTime(60 * 60 * 1000))

    const compact = screen.getByTestId("floating-call-square")
    expect(compact).toHaveStyle({ width: "380px" })
    expect(screen.getByLabelText("Call duration")).toHaveTextContent("1:00:00")
    expect(Array.from(compact.children)).toEqual([
      screen.getByTestId("minimized-call-drag-handle"),
      screen.getByTestId("minimized-call-content"),
      screen.getByLabelText(/Change call view/),
      screen.getByLabelText("Restore call"),
    ])
    expect(screen.getByTestId("minimized-call-controls").children).toHaveLength(3)
  })

  it("moves the minimized bar by dragging or focused arrow-key controls", async () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    fireEvent.click(screen.getByLabelText("Minimize call"), { clientX: 500, clientY: 300, detail: 1 })

    const compact = screen.getByTestId("floating-call-square")
    const handle = screen.getByTestId("minimized-call-drag-handle")
    handle.setPointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 300, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 600, clientY: 400, pointerId: 1 })
    expect(compact.style.left).toBe("244px")
    expect(compact.style.top).toBe("375px")

    handle.focus()
    expect(handle).toHaveFocus()
    await userEvent.keyboard("{ArrowLeft}")
    expect(compact.style.left).toBe("228px")
    expect(compact.style.top).toBe("375px")

    window.dispatchEvent(new Event("resize"))
    fireEvent.pointerMove(handle, { clientX: 700, clientY: 500, pointerId: 1 })
    expect(compact.style.left).toBe("228px")
    expect(compact.style.top).toBe("375px")
  })

  it("reclamps the expanded square before restore is painted", () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    fireEvent.click(screen.getByLabelText("Minimize call"), { clientX: 1000, clientY: 750, detail: 1 })
    expect(screen.getByTestId("floating-call-square").style.left).toBe("636px")
    expect(screen.getByTestId("floating-call-square").style.top).toBe("710px")

    fireEvent.click(screen.getByLabelText("Restore call"))
    expect(screen.getByTestId("floating-call-square").style.left).toBe("636px")
    expect(screen.getByTestId("floating-call-square").style.top).toBe("440px")
  })
})

describe("FloatingCallSquare — joining", () => {
  it("keeps the full floating surface mounted from connecting through connected", () => {
    renderSquare()
    act(() => setCallPhase("joining"))

    const joiningSquare = screen.getByTestId("floating-call-square")
    expect(joiningSquare).toHaveClass("min-h-[260px]")
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
    expect(screen.queryByText("Ada (you)")).toBeNull()
    expect(screen.queryByText("Grace")).toBeNull()
    // The old mobile-island pill (icon-only Cancel) must not render on the desktop square.
    expect(screen.queryByLabelText("Cancel joining")).toBeNull()

    enterConnected(TWO_PEERS)
    expect(screen.getByTestId("floating-call-square")).toBe(joiningSquare)
    expect(screen.getByText("Ada (you)")).toBeVisible()
    expect(screen.getByText("Grace")).toBeVisible()
  })

  it("renders the PreJoinGate permission taxonomy during an active launch, not a plain pill", async () => {
    const startCall = vi.fn(async () => {
      throw new CallCaptureError(
        "capture_failed",
        Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })
      )
    })
    renderSquareWithLaunch(makeManager({ startCall }))
    await userEvent.click(screen.getByText("launch"))
    expect(await screen.findByText(/Microphone access denied/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument()
    expect(screen.queryByLabelText("Cancel joining")).toBeNull()
  })

  it("offers no Minimize while joining — a bubble would hide the PreJoinGate", () => {
    renderSquare()
    act(() => setCallPhase("joining"))
    expect(screen.queryByLabelText("Minimize call")).toBeNull()
  })

  it("force-restores from a bubble if the call leaves the connected phase", async () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    await act(async () => fireEvent.click(screen.getByLabelText("Minimize call")))
    expect(screen.getByTestId("floating-call-square")).toHaveAttribute("data-minimized", "true")
    // Dropping out of connected (e.g. back to joining) must expand — never a stale bubble.
    act(() => setCallPhase("joining"))
    expect(screen.getByTestId("floating-call-square")).toHaveAttribute("data-minimized", "false")
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
  })
})

describe("FloatingCallSquare — drag", () => {
  it("surface menu options never start dragging the square", async () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    const square = screen.getByTestId("floating-call-square")
    const header = screen.getByTestId("floating-call-square-header")
    header.setPointerCapture = vi.fn()

    await userEvent.click(screen.getByLabelText(/Change call view/))
    fireEvent.pointerDown(screen.getByRole("menuitemradio", { name: "Sidebar" }), {
      clientX: 700,
      clientY: 100,
      pointerId: 1,
      isPrimary: true,
    })
    fireEvent.pointerMove(header, { clientX: 300, clientY: 200, pointerId: 1 })

    expect(square.style.left).toBe("676px")
    expect(square.style.top).toBe("440px")
  })

  it("dragging the header moves the square and settles without wedging", () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    const square = screen.getByTestId("floating-call-square")
    const header = screen.getByTestId("floating-call-square-header")
    header.setPointerCapture = vi.fn()

    fireEvent.pointerDown(header, { clientX: 676, clientY: 440, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(header, { clientX: 300, clientY: 200, pointerId: 1 })
    // jsdom viewport is 1024x768; the square measures 0px in jsdom so the clamp
    // bounds are margin..(viewport-margin). The move delta lands at (300, 200).
    expect(square.style.left).toBe("300px")
    expect(square.style.top).toBe("200px")

    fireEvent.pointerCancel(header, { clientX: 300, clientY: 200, pointerId: 1 })
    // Cancelled drag: a lone move must be a no-op (drag ref nulled — no wedge).
    fireEvent.pointerMove(header, { clientX: 50, clientY: 50, pointerId: 1 })
    expect(square.style.left).toBe("300px")
    expect(square.style.top).toBe("200px")
  })
})
