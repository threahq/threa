import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import * as useMobileModule from "@/hooks/use-mobile"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"

type CachedWorkspaceUser = Parameters<typeof seedWorkspaceCache>[1]["users"][number]
import {
  clearCallState,
  getCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  patchCallLocal,
  setCallActiveElsewhere,
  setDisplacedCall,
  setCallCaptureError,
  setCallSurfaceMode,
  setDesktopSurfaceOverride,
  bumpCallMediaEpoch,
  type CallRosterParticipant,
} from "@/stores/call-store"
import { __resetCallPrefsForTests, getCallPrefs, setDesktopCallSurface } from "@/stores/call-prefs-store"
import { CallCaptureError, type CallController } from "@/calls/call-manager"
import { ApiError } from "@/api/client"
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
    setCallTitle: vi.fn(),
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

function renderDock(
  manager: CallController,
  request: CallLaunchRequest = { workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }
) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <LaunchButton request={request} />
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
  resetWorkspaceTableRegistry()
  localStorage.clear()
  __resetCallPrefsForTests()
  // Default resolves to the floating square now; pin the sidebar dock so the dock-
  // specific cases below exercise their surface. The routing suite overrides per test.
  setDesktopCallSurface("sidebar")
  seedUsers()
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_self" } as ReturnType<typeof authModule.useUser>)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("CallDock — opening surface mode", () => {
  const REAL_UA = navigator.userAgent
  function setUserAgent(value: string) {
    Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => value })
  }
  afterEach(() => setUserAgent(REAL_UA))

  it("opens an audio call at compact", () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150")
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])

    expect(getCallState().surfaceMode).toBe("compact")
  })

  it("opens an audio call at standard on iOS, the only mode that shows the lock warning", () => {
    // `compact` is a fixed 72px pill with no room for the notice, so a warning
    // gated to the taller modes would never reach the user it is written for.
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])

    expect(getCallState().surfaceMode).toBe("standard")
  })
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

  it("says where the call went after another device took it over, and offers it back", async () => {
    const manager = makeManager()
    renderDock(manager)
    // The manager writes this after its teardown; the surface it was rendering is
    // already gone, so this chip is the only thing left that explains why.
    act(() =>
      setDisplacedCall({
        callId: "call_1",
        workspaceId: WORKSPACE_ID,
        streamId: "stream_1",
        mode: "video",
        reason: "taken_over",
      })
    )

    expect(screen.getByText(/moved to another device/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Rejoin here" }))
    // Asks for takeover outright: this chip only exists because the other device
    // holds the call, so a plain join would 409 and re-ask what the chip answered.
    expect(manager.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: "stream_1", expectedCallId: "call_1", takeover: true })
    )
  })

  it("dismisses the moved-call chip", async () => {
    renderDock(makeManager())
    act(() =>
      setDisplacedCall({
        callId: "call_1",
        workspaceId: WORKSPACE_ID,
        streamId: "stream_1",
        mode: "video",
        reason: "taken_over",
      })
    )
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/moved to another device/i)).toBeNull()
  })

  it("says the call ended while the phone was locked, with the same one-tap rejoin", async () => {
    const manager = makeManager()
    renderDock(manager)
    act(() =>
      setDisplacedCall({
        callId: "call_1",
        workspaceId: WORKSPACE_ID,
        streamId: "stream_1",
        mode: "video",
        reason: "ended_while_away",
      })
    )

    expect(screen.getByText(/ended while your phone was locked/i)).toBeInTheDocument()
    expect(screen.queryByText(/moved to another device/i)).toBeNull()
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Rejoin here" }))
    // Still a takeover launch: this device's own stale endpoint may hold the lease.
    expect(manager.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: "stream_1", expectedCallId: "call_1", takeover: true })
    )
  })

  it("blames the connection, not another device, when there is no evidence of a takeover", () => {
    renderDock(makeManager())
    act(() =>
      setDisplacedCall({
        callId: "call_1",
        workspaceId: WORKSPACE_ID,
        streamId: "stream_1",
        mode: "video",
        reason: "connection_lost",
      })
    )

    expect(screen.getByText(/lost its connection/i)).toBeInTheDocument()
    expect(screen.queryByText(/moved to another device/i)).toBeNull()
    expect(screen.getByRole("button", { name: "Rejoin here" })).toBeInTheDocument()
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

  it("offers to move the call here when another device holds it, and retries with takeover", async () => {
    // The server's 409 for "this user already has a live endpoint elsewhere".
    const startCall = vi.fn(async () => {
      throw new ApiError(409, "CALL_ENDPOINT_ACTIVE", "An active endpoint already exists for this user")
    })
    const manager = makeManager({ startCall })
    renderDock(manager)

    await userEvent.click(screen.getByText("launch"))
    expect(await screen.findByText(/in this call on another device/i)).toBeInTheDocument()
    // A choice, not a failure — no generic retry affordance.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Join on this device" }))
    expect(startCall).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      streamId: "stream_1",
      mode: "video",
      takeover: true,
    })
  })

  it("should ignore a second launch while the first is still awaiting the server", async () => {
    // phase stays "idle" until the REST start resolves, so only the provider's
    // synchronous in-flight guard separates this from startCall's "already
    // active" throw — which would paint a false join_error over a live join
    // (StrictMode double effect on the ?call= path, or a double-tap).
    const { toast } = await import("sonner")
    const error = vi.spyOn(toast, "error").mockReturnValue("t" as never)
    const startCall = vi.fn(() => new Promise<void>(() => {}))
    renderDock(makeManager({ startCall }))

    await userEvent.click(screen.getByText("launch"))
    await userEvent.click(screen.getByText("launch"))

    expect(startCall).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  it("should toast 'This call has ended' with no retry surface when the bound call is gone", async () => {
    const { toast } = await import("sonner")
    const info = vi.spyOn(toast, "info").mockReturnValue("t" as never)
    const error = vi.spyOn(toast, "error").mockReturnValue("t" as never)
    // The server's expectedCallId guard: the accepted call no longer exists.
    const startCall = vi.fn(async () => {
      throw new ApiError(409, "CALL_ENDED", "Call has ended")
    })
    renderDock(makeManager({ startCall }))

    await userEvent.click(screen.getByText("launch"))

    expect(info).toHaveBeenCalledWith("This call has ended")
    // Not a join_error: retrying would join a different call than accepted.
    expect(error).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  it("never takes over on a first attempt", async () => {
    const manager = makeManager()
    renderDock(manager)
    await userEvent.click(screen.getByText("launch"))
    // The launch request is passed through untouched — a plain join carries no
    // takeover, so the server's 409 (and the prompt) is what introduces it.
    expect(manager.startCall).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      streamId: "stream_1",
      mode: "video",
    })
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
    expect(screen.getByTestId("desktop-call-dock")).toHaveAttribute("data-phase", "joining")
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

describe("CallDock — lock-screen media session title", () => {
  function seedStreams(
    streams: Array<{ id: string; type: string; slug?: string | null; displayName?: string | null }>,
    dmPeers: Array<{ streamId: string; userId: string }> = []
  ) {
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
      streams: streams.map((s) => ({ ...s, workspaceId: WORKSPACE_ID, _cachedAt: Date.now() })),
      memberships: [],
      dmPeers: dmPeers.map((p) => ({ ...p, workspaceId: WORKSPACE_ID, _cachedAt: Date.now() })),
      personas: [],
      bots: [],
    } as unknown as Parameters<typeof seedWorkspaceCache>[1])
  }

  it("pushes the resolved channel name at the manager", () => {
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const manager = makeManager()
    renderDock(manager)
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(manager.setCallTitle).toHaveBeenCalledWith("#design")
  })

  it("resolves the label during the launch window, before the store has a call session", () => {
    // Ringing out is exactly when a locked phone reads the notification, and the
    // store's workspace id is null for that whole window — only the launch request
    // carries one. Clicked synchronously: awaiting lets the workspace store's IDB
    // read (empty in jsdom) land and clobber the seeded cache.
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const manager = makeManager({ startCall: vi.fn(() => new Promise<void>(() => {})) })
    renderDock(manager)

    act(() => screen.getByText("launch").click())

    expect(getCallState().workspaceId).toBeNull()
    expect(manager.setCallTitle).toHaveBeenCalledWith("#design")
  })

  it("resolves a DM to the peer's name — the case a hand-rolled lookup gets wrong", () => {
    // A DM the viewer can open is not necessarily in the streams cache, and its
    // `displayName` is null on the wire; only the peer lookup gets this right.
    seedStreams([], [{ streamId: "stream_dm", userId: "usr_peer" }])
    const manager = makeManager()
    renderDock(manager)
    act(() => {
      setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_dm", mode: "video" })
      setCallPhase("connected")
      setCallRoster([participant({ userId: "usr_self", endpointId: "callep_self" })], 1)
    })
    expect(manager.setCallTitle).toHaveBeenCalledWith("Grace")
  })
})

describe("CallDock — desktop surface routing", () => {
  it("floating pref renders the square for both joining and connected", () => {
    setDesktopCallSurface("floating")
    renderDock(makeManager())
    act(() => setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }))
    // Joining (launch idle): the square owns the joining surface, not the DockFrame.
    expect(screen.getByTestId("floating-call-square")).toBeInTheDocument()
    expect(screen.queryByLabelText("Collapse call")).toBeNull()
    act(() => {
      setCallPhase("connected")
      setCallRoster([participant({ userId: "usr_self", endpointId: "callep_self" })], 1)
    })
    expect(screen.getByTestId("floating-call-square")).toBeInTheDocument()
    expect(screen.getByTestId("call-tile")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-call-dock")).toBeNull()
  })

  it("keeps a camera-on joining dock at its final width through async cancel", async () => {
    const manager = makeManager({ startCall: vi.fn(() => new Promise<void>(() => {})) })
    renderDock(manager, {
      workspaceId: WORKSPACE_ID,
      streamId: "stream_1",
      mode: "video",
      cameraOn: true,
    })
    await userEvent.click(screen.getByText("launch"))

    expect(getCallState().local.cameraOn).toBe(false)
    const dock = screen.getByTestId("desktop-call-dock")
    expect(dock).toHaveAttribute("data-mode", "standard")

    act(() => setCallPhase("joining"))
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(manager.leaveCall).toHaveBeenCalled()
    expect(dock).toHaveAttribute("data-mode", "standard")
  })

  it("sidebar pref keeps the actual dock mounted from joining through connected", () => {
    // beforeEach pins sidebar.
    renderDock(makeManager())
    act(() => setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }))

    const joiningDock = screen.getByTestId("desktop-call-dock")
    expect(joiningDock).toHaveAttribute("data-phase", "joining")
    expect(joiningDock).toHaveAttribute("data-mode", "compact")
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
    expect(screen.queryByLabelText("Minimize call")).toBeNull()
    expect(screen.queryByTestId("floating-call-square")).toBeNull()

    act(() => {
      setCallPhase("connected")
      setCallRoster([participant({ userId: "usr_self", endpointId: "callep_self" })], 1)
    })
    expect(screen.getByTestId("desktop-call-dock")).toBe(joiningDock)
    expect(joiningDock).toHaveAttribute("data-phase", "connected")
    expect(screen.getByTestId("call-tile")).toBeInTheDocument()
    expect(screen.queryByTestId("floating-call-square")).toBeNull()
  })

  it("routes fullscreen joining and connected states as a peer surface and remembers it", async () => {
    setDesktopCallSurface("fullscreen")
    renderDock(makeManager())
    act(() => setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }))
    expect(screen.getByTestId("desktop-call-fullscreen")).toHaveAttribute("data-phase", "joining")
    expect(screen.getByText("Connecting…")).toBeInTheDocument()

    act(() => {
      setCallPhase("connected")
      setCallRoster([participant({ userId: "usr_self", endpointId: "callep_self" })], 1)
    })
    expect(screen.getByTestId("desktop-call-fullscreen")).toHaveAttribute("data-phase", "connected")
    expect(screen.getByTestId("call-layout-slot")).toBeInTheDocument()
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()

    const placementPicker = screen.getByLabelText("Change thumbnail placement. Current: Below video")
    expect(placementPicker).not.toHaveTextContent("Bottom")
    await userEvent.click(placementPicker)
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Thumbnails beside video" }))
    expect(getCallPrefs().filmstripSide).toBe("side")
  })

  it("leaves the thread panel's column free so call chat renders beside the fullscreen video", () => {
    setDesktopCallSurface("fullscreen")
    renderDock(makeManager())
    act(() => setCallSession({ callId: "call_1", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" }))

    const overlay = screen.getByTestId("desktop-call-fullscreen")
    expect(overlay.className).not.toContain("right-0")
    expect(overlay.getAttribute("style")).toContain("right: var(--panel-inset-right, 0px)")
    expect(overlay.getAttribute("style")).toContain(
      "transition: right var(--panel-inset-duration, 0ms) cubic-bezier(0, 0, 0.2, 1)"
    )
  })

  it("floating pref surfaces the pre-join permission gate inside the square during an active launch", async () => {
    setDesktopCallSurface("floating")
    const startCall = vi.fn(async () => {
      throw new CallCaptureError(
        "capture_failed",
        Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })
      )
    })
    renderDock(makeManager({ startCall }))
    await userEvent.click(screen.getByText("launch"))
    // The gate (not a bare "Joining…" pill) renders on the floating surface — no PreJoinGate = no way to recover permission.
    expect(screen.getByTestId("floating-call-square")).toBeInTheDocument()
    expect(await screen.findByText(/Microphone access denied/i)).toBeInTheDocument()
  })

  it("the square's Dock to the side flips to the dock and records the override + last", async () => {
    setDesktopCallSurface("floating")
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(screen.getByTestId("floating-call-square")).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/Change call view/))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Sidebar" }))
    expect(screen.getByTestId("desktop-call-dock")).toBeInTheDocument()
    expect(screen.queryByTestId("floating-call-square")).toBeNull()
    expect(getCallState().desktopSurfaceOverride).toBe("sidebar")
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
    expect(screen.getByLabelText(/Change call view/)).toHaveFocus()
  })

  it("opens a minimized Sidebar before moving picker focus into it", async () => {
    setDesktopCallSurface("floating")
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    act(() => setCallSurfaceMode("min"))

    await userEvent.click(screen.getByLabelText(/Change call view/))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Sidebar" }))

    expect(screen.getByTestId("desktop-call-dock")).toHaveAttribute("data-mode", "standard")
    expect(screen.getByLabelText(/Change call view/)).toHaveFocus()
  })

  it("does not move focus for a non-picker surface switch", () => {
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    const externalButton = document.createElement("button")
    document.body.append(externalButton)
    externalButton.focus()

    act(() => setDesktopSurfaceOverride("fullscreen"))

    expect(screen.getByTestId("desktop-call-fullscreen")).toBeInTheDocument()
    expect(externalButton).toHaveFocus()
    externalButton.remove()
  })

  it("the dock's Float flips to the square and records the override + last", async () => {
    // beforeEach pins sidebar.
    renderDock(makeManager())
    enterConnectedCall([participant({ userId: "usr_self", endpointId: "callep_self" })])
    expect(screen.getByTestId("desktop-call-dock")).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/Change call view/))
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Floating" }))
    expect(screen.getByTestId("floating-call-square")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-call-dock")).toBeNull()
    expect(getCallState().desktopSurfaceOverride).toBe("floating")
    expect(getCallPrefs().lastDesktopSurface).toBe("floating")
  })
})
