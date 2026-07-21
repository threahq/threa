import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent } from "@testing-library/react"
import { render, screen } from "@/test"
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
import type { CallController } from "@/calls/call-manager"
import { FloatingCallSquare, clampSquareToViewport } from "./floating-call-square"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider } from "./call-launch-context"

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
        <FloatingCallSquare workspaceId={WORKSPACE_ID} streamId="stream_1" onDockToSide={onDockToSide} />
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
  vi.restoreAllMocks()
})

describe("clampSquareToViewport", () => {
  const size = { width: 200, height: 200 }
  const viewport = { width: 1000, height: 800 }

  it("passes an in-bounds position through unchanged", () => {
    expect(clampSquareToViewport({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 })
  })

  it("clamps past each edge back to the on-screen bound", () => {
    expect(clampSquareToViewport({ x: -50, y: -50 }, size, viewport)).toEqual({ x: 8, y: 8 })
    expect(clampSquareToViewport({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 792, y: 592 })
  })

  it("respects a custom margin", () => {
    expect(clampSquareToViewport({ x: 0, y: 0 }, size, viewport, 20)).toEqual({ x: 20, y: 20 })
    expect(clampSquareToViewport({ x: 9999, y: 9999 }, size, viewport, 20)).toEqual({ x: 780, y: 580 })
  })

  it("clamps to the margin (never negative) when the square is larger than the viewport", () => {
    const big = { width: 2000, height: 2000 }
    expect(clampSquareToViewport({ x: 400, y: 400 }, big, viewport)).toEqual({ x: 8, y: 8 })
    expect(clampSquareToViewport({ x: -400, y: -400 }, big, viewport)).toEqual({ x: 8, y: 8 })
  })
})

describe("FloatingCallSquare — connected", () => {
  it("renders one tile per joined participant, Leave, and Dock to the side", () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    const square = screen.getByTestId("floating-call-square")
    expect(square).toHaveAttribute("data-minimized", "false")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    expect(screen.getByLabelText("Dock to the side")).toBeInTheDocument()
  })

  it("clicking Dock to the side calls onDockToSide", async () => {
    const onDockToSide = vi.fn()
    renderSquare(makeManager(), onDockToSide)
    enterConnected(TWO_PEERS)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dock to the side"))
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
  it("minimizes to a bubble (dot + timer) then restores to the tiles", async () => {
    renderSquare()
    enterConnected(TWO_PEERS)
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Minimize call"))
    })
    const bubble = screen.getByTestId("floating-call-square")
    expect(bubble).toHaveAttribute("data-minimized", "true")
    expect(screen.getByLabelText("Restore call")).toBeInTheDocument()
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.queryAllByTestId("call-tile")).toHaveLength(0)

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Restore call"))
    })
    expect(screen.getByTestId("floating-call-square")).toHaveAttribute("data-minimized", "false")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
  })
})

describe("FloatingCallSquare — joining", () => {
  it("renders the joining body (no tiles) when the phase is joining and the launch is idle", () => {
    renderSquare()
    act(() => setCallPhase("joining"))
    expect(screen.getByText("Joining…")).toBeInTheDocument()
    expect(screen.queryAllByTestId("call-tile")).toHaveLength(0)
    expect(screen.getByLabelText("Cancel joining")).toBeInTheDocument()
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
    expect(screen.getByText("Joining…")).toBeInTheDocument()
  })
})

describe("FloatingCallSquare — drag", () => {
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

    fireEvent.pointerUp(header, { clientX: 300, clientY: 200, pointerId: 1 })
    // Drag released: a lone move must be a no-op (drag ref nulled — no wedge).
    fireEvent.pointerMove(header, { clientX: 50, clientY: 50, pointerId: 1 })
    expect(square.style.left).toBe("300px")
    expect(square.style.top).toBe("200px")
  })
})
