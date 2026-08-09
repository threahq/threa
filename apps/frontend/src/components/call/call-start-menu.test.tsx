import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { fireEvent, render, screen, userEvent, waitFor } from "@/test"
import * as authModule from "@/auth"
import { clearCallState, setCallSession, setCallPhase } from "@/stores/call-store"
import { upsertActiveCall, __resetActiveCallsStore } from "@/stores/active-calls-store"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import type { CallController } from "@/calls/call-manager"
import { CallStartMenu } from "./call-start-menu"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider } from "./call-launch-context"

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

function renderMenu(manager: CallController) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <CallStartMenu workspaceId="ws_1" streamId="stream_1" />
      </CallLaunchProvider>
    </CallManagerProvider>
  )
}

beforeEach(() => {
  clearCallState()
  __resetActiveCallsStore()
  resetWorkspaceStoreCache()
  resetWorkspaceTableRegistry()
  // The menu reads viewer identity to tell "join" from "take over".
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_self" } as ReturnType<typeof authModule.useUser>)
})
afterEach(() => vi.restoreAllMocks())

/** Seed the viewer as a workspace user so identity resolves, then put them in the stream's live call. */
function seedSelfInLiveCall() {
  seedWorkspaceCache("ws_1", {
    workspace: {
      id: "ws_1",
      name: "WS",
      slug: "ws",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [
      {
        id: "usr_self",
        workspaceId: "ws_1",
        workosUserId: "workos_self",
        email: "self@example.com",
        role: "member",
        slug: "self",
        name: "Ada",
        _cachedAt: Date.now(),
      },
    ] as unknown as Parameters<typeof seedWorkspaceCache>[1]["users"],
    streams: [],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
  upsertActiveCall("ws_1", {
    callId: "call_1",
    streamId: "stream_1",
    rootStreamId: "stream_1",
    mode: "video",
    participantCount: 1,
    participantUserIds: ["usr_self"],
  })
}

describe("CallStartMenu", () => {
  it("starts a mic-only call on 'Start voice call'", async () => {
    const manager = makeManager()
    renderMenu(manager)
    await userEvent.click(screen.getByRole("button", { name: "Start call" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start voice call" }))
    expect(manager.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: false })
    )
  })

  it("starts with the camera on 'Start video call'", async () => {
    const manager = makeManager()
    renderMenu(manager)
    await userEvent.click(screen.getByRole("button", { name: "Start call" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start video call" }))
    expect(manager.startCall).toHaveBeenCalledWith(expect.objectContaining({ cameraOn: true }))
  })

  it("disables the trigger while a call is already active (no second start)", () => {
    renderMenu(makeManager())
    // Idle → enabled.
    expect(screen.getByRole("button", { name: "Start call" })).not.toBeDisabled()
    // A live call → the trigger disables, so a second concurrent start can't launch.
    act(() => {
      setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
      setCallPhase("connected")
    })
    expect(screen.getByRole("button", { name: "You're already in a call" })).toBeDisabled()
  })
})

describe("CallStartMenu — the call is on another device", () => {
  it("collapses to a single Take over action that displaces the other device", async () => {
    const manager = makeManager()
    seedSelfInLiveCall()
    renderMenu(manager)

    // No voice/video menu: the running call already decided that, and the only
    // open question is which device carries it.
    expect(screen.queryByRole("button", { name: "Start call" })).toBeNull()
    // fireEvent, not userEvent: userEvent's pointer sequence doesn't reach this
    // button's onClick under jsdom (the Radix triggers above are unaffected — they
    // act on pointerdown). A real browser click is covered by the calls e2e.
    fireEvent.click(screen.getByRole("button", { name: "Take over call on this device" }))
    await waitFor(() => expect(manager.startCall).toHaveBeenCalled())

    expect(manager.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: "stream_1", expectedCallId: "call_1", takeover: true })
    )
  })

  it("keeps the ordinary start menu when the live call does not include the viewer", () => {
    seedSelfInLiveCall()
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_other"],
    })
    renderMenu(makeManager())
    expect(screen.getByRole("button", { name: "Start call" })).toBeInTheDocument()
  })
})
