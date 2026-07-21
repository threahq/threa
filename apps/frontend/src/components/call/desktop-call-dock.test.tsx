import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, fireEvent } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import {
  clearCallState,
  getCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  setCallSurfaceMode,
  setCallCaptureError,
  type CallRosterParticipant,
  type CallSurfaceMode,
} from "@/stores/call-store"
import { getCallPrefs, __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import type { CallController } from "@/calls/call-manager"
import { DesktopCallDock } from "./desktop-call-dock"
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

function renderDock(manager: CallController = makeManager()) {
  return render(
    <CallManagerProvider manager={manager}>
      <DesktopCallDock workspaceId={WORKSPACE_ID} streamId="stream_1" />
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

function setMode(m: CallSurfaceMode) {
  act(() => setCallSurfaceMode(m))
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
  document.documentElement.removeAttribute("style")
  seedUsers()
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_self" } as ReturnType<typeof authModule.useUser>)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DesktopCallDock — side dock presentations", () => {
  it("min renders the Rail: restore chevron + timer, no controls", () => {
    renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("min")
    const dock = screen.getByTestId("desktop-call-dock")
    expect(dock).toHaveAttribute("data-mode", "min")
    expect(dock).toHaveAttribute("data-position", "side")
    expect(screen.getByRole("button", { name: "Expand call" })).toBeInTheDocument()
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.queryByLabelText("Mute")).toBeNull()
  })

  it("compact renders the Panel: tile grid, controls, minimize", () => {
    renderDock()
    enterConnected(TWO_PEERS)
    setMode("compact")
    expect(screen.getByTestId("desktop-call-dock")).toHaveAttribute("data-mode", "compact")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
    expect(screen.getByLabelText("Mute")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    expect(screen.getByLabelText("Minimize call")).toBeInTheDocument()
  })

  it("standard renders the Wide gallery: tiles + controls", () => {
    renderDock()
    enterConnected(TWO_PEERS)
    setMode("standard")
    expect(screen.getByTestId("desktop-call-dock")).toHaveAttribute("data-mode", "standard")
    expect(screen.getAllByTestId("call-tile")).toHaveLength(2)
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
  })
})

describe("DesktopCallDock — fullscreen", () => {
  it("mounts the ch5 stage, LayoutToggle, and the desktop filmstrip-side toggle", () => {
    renderDock()
    enterConnected([
      participant({ userId: "usr_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
      participant({ userId: "usr_third", endpointId: "callep_third" }),
    ])
    setMode("full")
    expect(screen.getByLabelText("Collapse call")).toBeInTheDocument()
    expect(screen.getByTestId("call-layout-slot")).toBeInTheDocument()
    expect(screen.getByTestId("call-stage-speaker")).toBeInTheDocument()
    expect(screen.getByTestId("call-filmstrip-side-toggle")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
  })

  it("the filmstrip-side toggle writes and persists filmstripSide", async () => {
    renderDock()
    enterConnected(TWO_PEERS)
    setMode("full")
    expect(getCallPrefs().filmstripSide).toBe("bottom")
    await userEvent.click(screen.getByRole("radio", { name: "Filmstrip side" }))
    expect(getCallPrefs().filmstripSide).toBe("side")
    expect(screen.getByTestId("call-stage-speaker")).toHaveAttribute("data-filmstrip-side", "side")
  })

  it("the collapse control lowers fullscreen to standard", async () => {
    renderDock()
    enterConnected(TWO_PEERS)
    setMode("full")
    await userEvent.click(screen.getByLabelText("Collapse call"))
    expect(getCallState().surfaceMode).toBe("standard")
  })
})

describe("DesktopCallDock — content push var", () => {
  function insetRight() {
    return document.documentElement.style.getPropertyValue("--call-dock-inset-right")
  }

  it("reserves the resting side width", () => {
    renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    expect(insetRight()).toBe("320px")
    setMode("standard")
    expect(insetRight()).toBe("520px")
  })

  it("drops the inset to 0 in fullscreen (the dock overlays, not pushes)", () => {
    renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("full")
    expect(insetRight()).toBe("0px")
  })

  it("resets the inset to 0 when the dock unmounts", () => {
    const { unmount } = renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    expect(insetRight()).toBe("320px")
    unmount()
    expect(insetRight()).toBe("0px")
  })
})

describe("DesktopCallDock — capture error", () => {
  it("surfaces a mid-call capture error banner in the Panel", () => {
    renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    act(() => setCallCaptureError({ code: "capture_rollback_failed", message: "boom" }))
    expect(screen.getByTestId("call-capture-error")).toHaveTextContent(/couldn't be restored/i)
  })
})

describe("DesktopCallDock — drag settles (no wedge)", () => {
  // jsdom has neither setPointerCapture nor a real layout; stub the rects the
  // handlers read so the drag physics run (the panel measures itself + the root).
  function stubRect(el: HTMLElement, box: Partial<DOMRect>) {
    el.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...box }) as DOMRect
  }

  it("dragging the side handle past the wide→full threshold caps the preview at standard and settles to full", () => {
    renderDock()
    enterConnected(TWO_PEERS)
    setMode("standard")
    const dock = screen.getByTestId("desktop-call-dock")
    stubRect(dock, { width: 520 })
    stubRect(dock.parentElement as HTMLElement, { width: 900 })
    const handle = screen.getByTestId("call-dock-handle")
    handle.setPointerCapture = vi.fn()
    // Drag the left edge leftward ~300px → width ~820 (past the full threshold).
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 })
    // Mid-drag the preview caps at `standard` (the fullscreen stage never mounts
    // during a drag — that thrash is what hung the capture harness), and the handle
    // stays mounted so the settle can fire.
    expect(screen.getByTestId("desktop-call-dock")).toHaveAttribute("data-mode", "standard")
    expect(screen.getByTestId("call-dock-handle")).toBeInTheDocument()
    fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 })
    expect(getCallState().surfaceMode).toBe("full")
    // The handle is still mounted at rest-fullscreen (drag back out of fullscreen).
    expect(screen.getByTestId("call-dock-handle")).toBeInTheDocument()
  })

  it("a pointercancel mid-drag settles instead of wedging", () => {
    renderDock()
    enterConnected([participant({ userId: "usr_self" })])
    setMode("compact")
    const dock = screen.getByTestId("desktop-call-dock")
    stubRect(dock, { width: 320 })
    stubRect(dock.parentElement as HTMLElement, { width: 900 })
    const handle = screen.getByTestId("call-dock-handle")
    handle.setPointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerCancel(handle, { clientX: 100, pointerId: 1 })
    // The cancel must settle (onPointerUp ran): surfaceMode moved off "compact".
    expect(["standard", "full"]).toContain(getCallState().surfaceMode)
  })
})
