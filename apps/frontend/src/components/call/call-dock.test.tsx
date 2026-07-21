import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import * as useMobileModule from "@/hooks/use-mobile"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"

type CachedWorkspaceUser = Parameters<typeof seedWorkspaceCache>[1]["users"][number]
import {
  clearCallState,
  getCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  patchCallLocal,
  setCallActiveElsewhere,
  setCallCaptureError,
  setCallSurfaceMode,
  bumpCallMediaEpoch,
  type CallRosterParticipant,
} from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { CallCaptureError, type CallController } from "@/calls/call-manager"
import { CallDock } from "./call-dock"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider, useCallLaunch, type CallLaunchRequest } from "./call-launch-context"

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
    userId: "usr_x",
    participantStatus: "joined",
    endpointId: "callep_x",
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

function LaunchButton({ request }: { request: CallLaunchRequest }) {
  const { launch } = useCallLaunch()
  return (
    <button type="button" onClick={() => launch(request)}>
      launch
    </button>
  )
}

function renderDock(manager: CallController) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <LaunchButton request={{ workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }} />
        <CallDock />
      </CallLaunchProvider>
    </CallManagerProvider>
  )
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

function enterConnectedCall(roster: CallRosterParticipant[]) {
  act(() => {
    setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })
    setCallPhase("connected")
    setCallRoster(roster, 1)
  })
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

describe("CallDock — idle", () => {
  it("renders nothing when idle with no launch or cross-tab call", () => {
    const { container } = renderDock(makeManager())
    expect(container.querySelector('[data-testid="call-tile"]')).toBeNull()
    expect(screen.queryByText(/active in another tab/i)).toBeNull()
  })

  it("shows the active-elsewhere chip when another tab holds the call", () => {
    renderDock(makeManager())
    act(() => setCallActiveElsewhere(true))
    expect(screen.getByText(/Call active in another tab/i)).toBeInTheDocument()
  })
})

describe("CallDock — connected roster", () => {
  it("renders a tile per joined participant with names, self marker, and mute + reconnecting state", () => {
    renderDock(makeManager())
    enterConnectedCall([
      participant({ userId: "usr_self", endpointId: "callep_self" }),
      participant({
        userId: "usr_peer",
        endpointId: "callep_peer",
        connectionStatus: "reconnecting",
        mediaState: { muted: true },
      }),
    ])
    const tiles = screen.getAllByTestId("call-tile")
    expect(tiles).toHaveLength(2)
    expect(screen.getByText("Ada (you)")).toBeInTheDocument()
    expect(screen.getByText("Grace")).toBeInTheDocument()
    // Peer is muted + reconnecting.
    expect(screen.getByLabelText("Muted")).toBeInTheDocument()
    expect(screen.getByText(/Reconnecting/i)).toBeInTheDocument()
  })

  it("dispatches mute, camera, and leave to the manager (success stays silent — INV-63)", async () => {
    const manager = makeManager()
    renderDock(manager)
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])

    await userEvent.click(screen.getByLabelText("Mute"))
    expect(manager.setMuted).toHaveBeenCalledWith(true)

    await userEvent.click(screen.getByLabelText("Turn camera on"))
    expect(manager.setCameraOn).toHaveBeenCalledWith(true)

    await userEvent.click(screen.getByLabelText("Leave call"))
    expect(manager.leaveCall).toHaveBeenCalled()
  })

  it("surfaces a mid-call capture error as an in-dock banner", () => {
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    act(() => setCallCaptureError({ code: "capture_rollback_failed", message: "boom" }))
    expect(screen.getByTestId("call-capture-error")).toHaveTextContent(/couldn't be restored/i)
  })

  it("attaches the manager's per-endpoint video stream to the tile <video> on a media-epoch tick", () => {
    const fakeStream = { id: "fake" } as unknown as MediaStream
    const getVideoStream = vi.fn((endpointId: string) => (endpointId === "callep_self" ? fakeStream : null))
    renderDock(makeManager({ getVideoStream }))
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    act(() => bumpCallMediaEpoch())
    const video = screen.getByTestId("call-tile-video") as HTMLVideoElement
    expect(video.srcObject).toBe(fakeStream)
  })

  it("mirrors the self tile's video (desktop default) but not a peer's", () => {
    const { container } = renderDock(makeManager())
    enterConnectedCall([
      participant({ userId: "usr_self", endpointId: "callep_self" }),
      participant({ userId: "usr_peer", endpointId: "callep_peer" }),
    ])
    // Desktop default (auto → mirror any camera); peers always see the un-mirrored feed.
    expect(container.querySelector('[data-user-id="usr_self"] video')?.className).toContain("-scale-x-100")
    expect(container.querySelector('[data-user-id="usr_peer"] video')?.className).not.toContain("-scale-x-100")
  })

  it("flips the self-mirror only when the SELF stream re-binds, not on any mediaEpoch", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    let selfStream = { id: "s1" } as unknown as MediaStream
    const manager = makeManager({ getVideoStream: (ep: string) => (ep === "callep_self" ? selfStream : null) })
    const { container } = renderDock(manager)
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    act(() => setCallSurfaceMode("standard")) // tiles render in the gallery, not the compact bar
    const selfVideo = () => container.querySelector('[data-user-id="usr_self"] video')
    // Mobile front (facingMode null) → mirrored.
    expect(selfVideo()?.className).toContain("-scale-x-100")
    // Flip sets facingMode synchronously — but the still-displayed old frames must NOT flip.
    act(() => patchCallLocal({ devices: { ...getCallState().local.devices, facingMode: "environment" } }))
    expect(selfVideo()?.className).toContain("-scale-x-100")
    // A REMOTE video change bumps mediaEpoch but the self stream is unchanged → still no flip.
    act(() => bumpCallMediaEpoch())
    expect(selfVideo()?.className).toContain("-scale-x-100")
    // The self camera republishes a NEW stream → now the mirror follows the new facing.
    act(() => {
      selfStream = { id: "s2" } as unknown as MediaStream
      bumpCallMediaEpoch()
    })
    expect(selfVideo()?.className).not.toContain("-scale-x-100")
  })

  it("reflects a local mute toggle in the control label without a toast", () => {
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(screen.getByLabelText("Mute")).toBeInTheDocument()
    act(() => patchCallLocal({ muted: true }))
    expect(screen.getByLabelText("Unmute")).toBeInTheDocument()
  })
})

describe("CallDock — pre-join permission taxonomy", () => {
  async function launchWithError(name: string, message = "") {
    // The taxonomy is derived from startCall's own typed capture failure (single
    // media acquisition in the manager), so the fake manager rejects startCall with
    // a CallCaptureError wrapping the raw getUserMedia DOMException.
    const startCall = vi.fn(async () => {
      throw new CallCaptureError("capture_failed", Object.assign(new Error(message), { name }))
    })
    renderDock(makeManager({ startCall }))
    await userEvent.click(screen.getByText("launch"))
  }

  it("renders denied copy for a plain permission denial", async () => {
    await launchWithError("NotAllowedError", "Permission denied")
    expect(await screen.findByText(/Microphone access denied/i)).toBeInTheDocument()
  })

  it("renders no-device copy when hardware is missing", async () => {
    await launchWithError("NotFoundError")
    expect(await screen.findByText(/No microphone found/i)).toBeInTheDocument()
  })

  it("renders device-busy copy when the mic is in use", async () => {
    await launchWithError("NotReadableError")
    expect(await screen.findByText(/microphone is busy/i)).toBeInTheDocument()
  })

  it("renders blocked-by-policy copy", async () => {
    await launchWithError("NotAllowedError", "disallowed by permissions policy")
    expect(await screen.findByText(/blocked here/i)).toBeInTheDocument()
  })

  it("starts the call through the manager on launch", async () => {
    const manager = makeManager()
    renderDock(manager)
    await userEvent.click(screen.getByText("launch"))
    expect(manager.startCall).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })
  })

  it("ignores a launch while already in a call (no stale join_error)", async () => {
    const manager = makeManager()
    renderDock(manager)
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    await userEvent.click(screen.getByText("launch"))
    expect(manager.startCall).not.toHaveBeenCalled()
  })

  it("shows the pre-join gate on a fresh launch after the prior call was minimized", async () => {
    const startCall = vi.fn(() => new Promise<void>(() => {}))
    renderDock(makeManager({ startCall }))
    // Enter a connected call, then minimize the desktop dock to its Rail.
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    await userEvent.click(screen.getByLabelText("Minimize call"))
    expect(screen.getByLabelText("Expand call")).toBeInTheDocument()
    // Call ends; a fresh launch must surface the pre-join gate, not stay hidden.
    act(() => setCallPhase("idle"))
    await userEvent.click(screen.getByText("launch"))
    expect(await screen.findByText("Joining…")).toBeInTheDocument()
  })
})

describe("CallDock — mobile drawer vs desktop dock", () => {
  function forceMobile(value: boolean) {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(value)
  }

  it("renders the mobile drawer (Tab) on a phone, not the desktop dock", () => {
    forceMobile(true)
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(screen.getByTestId("mobile-call-drawer")).toBeInTheDocument()
    // Tab is timer-only: no dock chevron and no tiles until it is opened.
    expect(screen.getByLabelText("Call duration")).toBeInTheDocument()
    expect(screen.queryByLabelText("Collapse call")).toBeNull()
    expect(screen.queryByTestId("call-tile")).toBeNull()
  })

  it("renders the desktop dock, not the drawer, on a wide viewport", () => {
    forceMobile(false)
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(screen.queryByTestId("mobile-call-drawer")).toBeNull()
    expect(screen.getByTestId("desktop-call-dock")).toBeInTheDocument()
    expect(screen.getByTestId("call-tile")).toBeInTheDocument()
    expect(screen.getByLabelText("Minimize call")).toBeInTheDocument()
  })

  it("opens the drawer to the compact bar on connect (no camera), controls live", async () => {
    forceMobile(true)
    const manager = makeManager()
    renderDock(manager)
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    // Mobile now opens into the first open state (compact bar), not the min Tab.
    expect(screen.getByTestId("mobile-call-drawer")).toHaveAttribute("data-mode", "compact")
    await userEvent.click(screen.getByLabelText("Leave call"))
    expect(manager.leaveCall).toHaveBeenCalled()
  })

  it("opens to the gallery (standard) when joining with the camera on", () => {
    forceMobile(true)
    renderDock(makeManager())
    act(() => {
      setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })
      patchCallLocal({ cameraOn: true })
      setCallPhase("connected")
      setCallRoster([participant({ userId: "usr_self", endpointId: "callep_self" })], 1)
    })
    expect(screen.getByTestId("mobile-call-drawer")).toHaveAttribute("data-mode", "standard")
  })

  it("keeps the capture error visible on the mobile Tab", () => {
    forceMobile(true)
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    act(() => setCallCaptureError({ code: "capture_rollback_failed", message: "boom" }))
    expect(screen.getByTestId("call-capture-error")).toBeInTheDocument()
  })

  it("renders the joining state as the top island pill, not the desktop dock", async () => {
    forceMobile(true)
    // startCall never settles → the launch stays in the requesting/joining state.
    renderDock(makeManager({ startCall: vi.fn(() => new Promise<void>(() => {})) }))
    await userEvent.click(screen.getByText("launch"))
    expect(await screen.findByText("Joining…")).toBeInTheDocument()
    // The island's cancel is icon-only (aria-label); the desktop gate uses a text
    // "Cancel" button, so this label uniquely proves the mobile island rendered.
    expect(screen.getByLabelText("Cancel joining")).toBeInTheDocument()
  })

  it("still surfaces the permission taxonomy on mobile (top card, reachable + retryable)", async () => {
    forceMobile(true)
    const startCall = vi.fn(async () => {
      throw new CallCaptureError(
        "capture_failed",
        Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })
      )
    })
    renderDock(makeManager({ startCall }))
    await userEvent.click(screen.getByText("launch"))
    expect(await screen.findByText(/Microphone access denied/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument()
  })
})
