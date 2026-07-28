import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import * as useMobileModule from "@/hooks/use-mobile"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import {
  clearCallState,
  getCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  setCallDevices,
  setCallSurfaceMode,
  setCallCaptureError,
  type CallDeviceState,
  type CallRosterParticipant,
  type CallSurfaceMode,
} from "@/stores/call-store"
import { getCallPrefs, __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import type { CallController } from "@/calls/call-manager"
import { MobileCallDrawer } from "./mobile-call-drawer"
import { CallManagerProvider } from "./call-manager-context"

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
    setCallTitle: vi.fn(),
    ...overrides,
  }
}

function device(deviceId: string, label: string, kind: MediaDeviceKind = "videoinput"): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: "grp", toJSON: () => ({}) } as MediaDeviceInfo
}

function makeDevices(overrides: Partial<CallDeviceState> = {}): CallDeviceState {
  return {
    inputs: [],
    outputs: [],
    cameras: [],
    selectedInputId: null,
    selectedOutputId: null,
    selectedCameraId: null,
    facingMode: null,
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

function renderDrawer(manager: CallController = makeManager(), streamId = "stream_1") {
  return render(
    <CallManagerProvider manager={manager}>
      <MobileCallDrawer workspaceId={WORKSPACE_ID} streamId={streamId} />
    </CallManagerProvider>
  )
}

function enterConnected(roster: CallRosterParticipant[], mode: "video" | "audio_only" = "video") {
  act(() => {
    setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode })
    setCallPhase("connected")
    setCallRoster(roster, 1)
  })
}

function setMode(m: CallSurfaceMode) {
  act(() => setCallSurfaceMode(m))
}

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

describe("MobileCallDrawer — mode rendering", () => {
  it("Tab (min): timer only, no controls", () => {
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("min")
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Expand call" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Mute")).toBeNull()
    expect(screen.queryByLabelText("Leave call")).toBeNull()
  })

  it("Bar (compact): adds mute, camera, and leave", () => {
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.getByLabelText("Mute")).toBeInTheDocument()
    expect(screen.getByLabelText("Turn camera on")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    // Full control extras are not in the compact bar.
    expect(screen.queryByLabelText("Connection diagnostics")).toBeNull()
  })

  it("Bar (compact): shows the flip control on mobile with more than one camera", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    act(() => setCallDevices(makeDevices({ cameras: [device("c1", "Front"), device("c2", "Back")] })))
    setMode("compact")
    expect(screen.getByLabelText("Flip camera")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
  })

  it("Tiny gallery (standard): adds a tile grid, flip, and the device menu", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    renderDrawer()
    enterConnected([
      participant({ userId: "usr_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
    ])
    // A live call always has a mic; the device menu keeps mic/speaker on mobile
    // (per-camera selection is hidden there — flip is the only camera control).
    act(() =>
      setCallDevices(
        makeDevices({
          cameras: [device("c1", "Front"), device("c2", "Back")],
          inputs: [device("m1", "Mic", "audioinput")],
        })
      )
    )
    setMode("standard")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
    expect(screen.getByLabelText("Flip camera")).toBeInTheDocument()
    expect(screen.getByLabelText("Devices")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
  })

  it("Fullscreen (full): shows the stage, collapse chevron, ch5 layout seam, and full controls", () => {
    renderDrawer()
    enterConnected([
      participant({ userId: "usr_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
    ])
    act(() => setCallDevices(makeDevices({ cameras: [device("c1", "Front")] })))
    setMode("full")
    expect(screen.getByLabelText("Collapse call")).toBeInTheDocument()
    expect(screen.getByTestId("call-layout-slot")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    expect(screen.getByLabelText("Devices")).toBeInTheDocument()
    expect(screen.getByTestId("call-stage-speaker")).toHaveClass("bg-call-stage")
    expect(screen.getByLabelText("Collapse call").parentElement?.parentElement).toHaveClass(
      "bg-call-stage",
      "text-white"
    )
    expect(screen.getAllByTestId("call-tile").length).toBeGreaterThan(0)
  })
})

describe("MobileCallDrawer — fullscreen layout switch (ch5)", () => {
  it("mounts the LayoutToggle and switches Speaker↔Grid, persisting the pref", async () => {
    renderDrawer()
    enterConnected([
      participant({ userId: "usr_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
      participant({ userId: "usr_third", endpointId: "callep_third" }),
    ])
    setMode("full")

    const speaker = screen.getByRole("radio", { name: "Speaker" })
    const grid = screen.getByRole("radio", { name: "Grid" })
    expect(speaker).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("call-stage-speaker")).toBeInTheDocument()
    expect(screen.getByTestId("call-filmstrip")).toBeInTheDocument()

    await userEvent.click(grid)
    expect(getCallPrefs().layout).toBe("grid")
    expect(screen.getByTestId("call-stage-grid")).toBeInTheDocument()
    expect(screen.queryByTestId("call-stage-speaker")).toBeNull()

    await userEvent.click(speaker)
    expect(getCallPrefs().layout).toBe("speaker")
    expect(screen.getByTestId("call-filmstrip")).toBeInTheDocument()
  })
})

describe("MobileCallDrawer — mode transitions", () => {
  it("tapping the Tab pill steps up to compact", async () => {
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("min")
    await userEvent.click(screen.getByRole("button", { name: "Expand call" }))
    expect(getCallState().surfaceMode).toBe("compact")
  })

  it("the fullscreen collapse chevron lowers it to standard", async () => {
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("full")
    await userEvent.click(screen.getByLabelText("Collapse call"))
    expect(getCallState().surfaceMode).toBe("standard")
  })
})

describe("MobileCallDrawer — capture error visible in every mode", () => {
  const modes: CallSurfaceMode[] = ["min", "compact", "standard", "full"]
  for (const m of modes) {
    it(`surfaces the capture error in ${m} mode`, () => {
      renderDrawer()
      enterConnected([participant({ userId: "usr_self" })])
      act(() => setCallCaptureError({ code: "capture_rollback_failed", message: "boom" }))
      setMode(m)
      expect(screen.getByTestId("call-capture-error")).toBeInTheDocument()
    })
  }
})

describe("MobileCallDrawer — global", () => {
  it("renders from call-store state even when the stream is not in the route/cache", () => {
    // A streamId that matches no cached stream (name falls back to "Call"): the
    // drawer reads the call store, not the route, so it still shows.
    renderDrawer(makeManager(), "stream_not_in_cache")
    enterConnected([participant({ userId: "usr_self" })])
    setMode("min")
    expect(screen.getByTestId("mobile-call-drawer")).toBeInTheDocument()
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
  })

  it("dispatches leave to the manager from the bar (success stays silent — INV-63)", async () => {
    const manager = makeManager()
    renderDrawer(manager)
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    await userEvent.click(screen.getByLabelText("Leave call"))
    expect(manager.leaveCall).toHaveBeenCalled()
  })
})

describe("MobileCallDrawer — drag settles (no wedge)", () => {
  // jsdom has neither setPointerCapture nor a real layout; stub both so the drag
  // handlers run. The drawer measures its own height on pointerdown.
  function primeDrag(startHeightPx: number) {
    const drawer = screen.getByTestId("mobile-call-drawer")
    drawer.getBoundingClientRect = () =>
      ({
        height: startHeightPx,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
    const handle = screen.getByTestId("call-drawer-handle")
    handle.setPointerCapture = vi.fn()
    return handle
  }

  it("dragging past the standard→full threshold keeps the handle mounted and settles to full", () => {
    renderDrawer()
    enterConnected([
      participant({ userId: "usr_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
    ])
    setMode("standard")
    const handle = primeDrag(248)
    // Drag down ~120px → height ~368 (> the 334 standard↔full midpoint) → content
    // crosses into fullscreen mid-drag. Before the fix the handle unmounted here
    // and pointerup could never fire (drawer wedged).
    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 420, pointerId: 1 })
    expect(screen.getByTestId("mobile-call-drawer")).toHaveAttribute("data-mode", "full")
    expect(screen.getByTestId("call-drawer-handle")).toBeInTheDocument()
    fireEvent.pointerUp(handle, { clientY: 420, pointerId: 1 })
    expect(getCallState().surfaceMode).toBe("full")
  })

  it("a pointercancel mid-drag settles instead of wedging", () => {
    renderDrawer()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    const handle = primeDrag(80)
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 300, pointerId: 1 }) // dragged down toward standard/full
    fireEvent.pointerCancel(handle, { clientY: 300, pointerId: 1 })
    // The cancel must settle (onPointerUp ran): surfaceMode moved off the starting
    // "compact" to the dragged-toward region. Exact detent depends on the (near-
    // instant jsdom) velocity/flick, so assert it settled, not the precise mode.
    // Before the fix, pointercancel was unhandled → surfaceMode stayed "compact".
    expect(["standard", "full"]).toContain(getCallState().surfaceMode)
  })
})
