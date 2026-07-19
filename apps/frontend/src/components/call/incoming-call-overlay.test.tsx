import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { IncomingCallOverlay } from "./incoming-call-overlay"
import * as launchCtx from "./call-launch-context"
import * as ringTone from "@/calls/ring-tone"
import { api } from "@/api/client"
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
      <IncomingCallOverlay />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetIncomingCallStoreCache()
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

    expect(launch).toHaveBeenCalledWith({ workspaceId: "ws_1", streamId: "stream_dm", mode: "video" })
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
})
