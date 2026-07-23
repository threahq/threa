import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { toast } from "sonner"
import { IncomingCallOverlay } from "./incoming-call-overlay"
import * as launchCtx from "./call-launch-context"
import * as ringTone from "@/calls/ring-tone"
import * as workspacesHooks from "@/hooks/use-workspaces"
import * as useMobileModule from "@/hooks/use-mobile"
import * as workspaceStore from "@/stores/workspace-store"
import { api } from "@/api/client"
import { clearCallState, setCallSurfaceMode } from "@/stores/call-store"
import { __resetCallPrefsForTests, setDesktopCallSurface } from "@/stores/call-prefs-store"
import {
  addIncomingCall,
  settleIncomingCall,
  resetIncomingCallStoreCache,
  getIncomingCalls,
  type IncomingCall,
} from "@/stores/incoming-call-store"

function makeCall(overrides: Partial<IncomingCall> = {}): IncomingCall {
  return {
    attemptId: "callinv_1",
    callId: "call_1",
    workspaceId: "ws_1",
    streamId: "stream_dm",
    inviterId: "usr_a",
    inviterName: "Ada",
    mode: "video",
    expiresAtMs: Date.now() + 45_000,
    ...overrides,
  }
}

let launch: ReturnType<typeof vi.fn>

function renderOverlay() {
  return render(
    <MemoryRouter>
      <IncomingCallOverlay workspaceId="ws_1" />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetIncomingCallStoreCache()
  clearCallState()
  localStorage.clear()
  __resetCallPrefsForTests()
  launch = vi.fn()
  vi.spyOn(launchCtx, "useCallLaunch").mockReturnValue({
    launch: launch as unknown as (request: launchCtx.CallLaunchRequest) => void,
    callActive: false,
    state: { status: "idle" },
    retry: vi.fn(),
    cancel: vi.fn(),
  })
  vi.spyOn(ringTone, "installRingAudioWarmup").mockReturnValue(() => {})
  vi.spyOn(ringTone, "startRing").mockReturnValue(true)
  vi.spyOn(ringTone, "stopRing").mockReturnValue(undefined)
  // Default: no notification suppression (level not none, no do-not-disturb).
  vi.spyOn(workspacesHooks, "useCurrentWorkspaceUser").mockReturnValue(null)
  vi.spyOn(workspaceStore, "useWorkspaceUserPreferences").mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  resetIncomingCallStoreCache()
  vi.restoreAllMocks()
})

describe("IncomingCallOverlay", () => {
  it("renders a live ring with the caller name and media mode", () => {
    act(() => addIncomingCall(makeCall()))
    renderOverlay()
    expect(screen.getByText("Ada is calling…")).toBeInTheDocument()
    expect(screen.getByText("Video call")).toBeInTheDocument()
  })

  it("does not steal focus on mount (no autofocus, no key binding)", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    // The overlay mounted but the pre-existing focus is untouched.
    expect(screen.getByLabelText("Accept call")).toBeInTheDocument()
    expect(document.activeElement).toBe(input)
    input.remove()
  })

  it("Accept joins the call and clears the ring", async () => {
    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    await userEvent.click(screen.getByLabelText("Accept call"))

    expect(launch).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      streamId: "stream_dm",
      mode: "video",
      expectedCallId: "call_1",
    })
    expect(getIncomingCalls()).toEqual([])
  })

  it("Decline hits the invitee-scoped REST endpoint and clears the ring", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({} as never)
    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    await userEvent.click(screen.getByLabelText("Decline call"))

    expect(post).toHaveBeenCalledWith("/api/workspaces/ws_1/calls/invitations/callinv_1/decline", {})
    expect(getIncomingCalls()).toEqual([])
  })

  it("clears when the ring settles from another device", () => {
    act(() => addIncomingCall(makeCall()))
    renderOverlay()
    expect(screen.getByText("Ada is calling…")).toBeInTheDocument()

    act(() => settleIncomingCall("callinv_1"))
    expect(screen.queryByText("Ada is calling…")).not.toBeInTheDocument()
  })

  it("falls back to a local SW notification when the ring audio can't sound (no gesture yet)", async () => {
    vi.spyOn(ringTone, "startRing").mockReturnValue(false)
    const showNotification = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global.navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification }) },
    })

    act(() => addIncomingCall(makeCall()))
    renderOverlay()
    await Promise.resolve()

    expect(showNotification).toHaveBeenCalledWith(
      "Ada is calling…",
      expect.objectContaining({ tag: "call-callinv_1", body: "Video call" })
    )
  })

  it("suppresses the audible ring on do-not-disturb but still renders the card", () => {
    vi.spyOn(workspacesHooks, "useCurrentWorkspaceUser").mockReturnValue({
      statusEmoji: null,
      statusText: null,
      statusExpiresAt: null,
      statusPausesNotifications: false,
      notificationsPausedUntil: null,
      notificationsPausedIndefinitely: true,
    } as never)

    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    // The visual card stays — the ring is still actionable, just silent.
    expect(screen.getByText("Ada is calling…")).toBeInTheDocument()
    expect(ringTone.startRing).not.toHaveBeenCalled()
  })

  it("suppresses the audible ring when the notification level is none", () => {
    vi.spyOn(workspaceStore, "useWorkspaceUserPreferences").mockReturnValue({ notificationLevel: "none" } as never)

    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    expect(screen.getByText("Ada is calling…")).toBeInTheDocument()
    expect(ringTone.startRing).not.toHaveBeenCalled()
  })

  it("scopes mute per attempt — a later ring still sounds", async () => {
    act(() => addIncomingCall(makeCall({ attemptId: "callinv_A", callId: "call_A" })))
    renderOverlay()

    await userEvent.click(screen.getByLabelText("Silence ring"))
    ;(ringTone.startRing as ReturnType<typeof vi.fn>).mockClear()

    act(() => addIncomingCall(makeCall({ attemptId: "callinv_B", callId: "call_B", inviterName: "Bo" })))

    expect(ringTone.startRing).toHaveBeenCalled()
  })

  it("tells the user when a ?call deep-link has no matching live ring", () => {
    const info = vi.spyOn(toast, "info").mockReturnValue("t" as never)

    render(
      <MemoryRouter initialEntries={["/?call=call_missing"]}>
        <IncomingCallOverlay workspaceId="ws_1" />
      </MemoryRouter>
    )

    expect(info).toHaveBeenCalledWith("This call has ended")
  })

  it("ignores stale mobile fullscreen state when clearing a desktop sidebar", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    setDesktopCallSurface("sidebar")
    act(() => {
      setCallSurfaceMode("full")
      addIncomingCall(makeCall())
    })
    ;(launchCtx.useCallLaunch as ReturnType<typeof vi.fn>).mockReturnValue({
      launch,
      callActive: true,
      state: { status: "idle" },
      retry: vi.fn(),
      cancel: vi.fn(),
    })
    renderOverlay()
    expect(screen.getByTestId("incoming-call-overlay")).toHaveClass("bottom-[calc(var(--composer-height,5rem)_+_1rem)]")
  })

  it("uses mobile fullscreen state when clearing the mobile controls", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    setDesktopCallSurface("sidebar")
    act(() => {
      setCallSurfaceMode("full")
      addIncomingCall(makeCall())
    })
    ;(launchCtx.useCallLaunch as ReturnType<typeof vi.fn>).mockReturnValue({
      launch,
      callActive: true,
      state: { status: "idle" },
      retry: vi.fn(),
      cancel: vi.fn(),
    })
    renderOverlay()
    expect(screen.getByTestId("incoming-call-overlay")).toHaveClass(
      "bottom-[calc(var(--composer-height,5rem)_+_5.5rem)]"
    )
  })

  it("announces the ring through an alert live region", () => {
    act(() => addIncomingCall(makeCall()))
    renderOverlay()

    expect(screen.getByRole("alert")).toHaveTextContent("Ada is calling…")
  })
})
