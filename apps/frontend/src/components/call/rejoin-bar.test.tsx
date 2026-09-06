import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { StreamActiveCall } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as launchModule from "./call-launch-context"
import * as callHooksModule from "./call-store-hooks"
import { api } from "@/api/client"
import { seedActiveCalls, removeActiveCall, __resetActiveCallsStore } from "@/stores/active-calls-store"
import { RejoinBar } from "./rejoin-bar"

const launch = vi.fn()

function stubBootstrap(activeCall: StreamActiveCall | null) {
  vi.spyOn(hooksModule, "useStreamBootstrap").mockReturnValue({
    data: { activeCall },
  } as unknown as ReturnType<typeof hooksModule.useStreamBootstrap>)
}

/** Mark call_1 live in the active-calls store — the liveness source the bar reads. */
function seedStoreLive() {
  seedActiveCalls("ws_1", [
    { callId: "call_1", streamId: "stream_1", rootStreamId: "stream_1", mode: "video", participantCount: 1 },
  ])
}

const LIVE: StreamActiveCall = {
  callId: "call_1",
  mode: "video",
  participantCount: 1,
  participantUserIds: ["usr_a"],
  selfLiveParticipant: true,
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetActiveCallsStore()
  launch.mockClear()
  vi.spyOn(launchModule, "useCallLaunch").mockReturnValue({
    launch,
  } as unknown as ReturnType<typeof launchModule.useCallLaunch>)
  vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("idle")
  vi.spyOn(callHooksModule, "useCallStreamId").mockReturnValue(null)
  vi.spyOn(api, "post").mockResolvedValue({} as never)
})

function renderBar() {
  return render(<RejoinBar workspaceId="ws_1" streamId="stream_1" />)
}

describe("RejoinBar", () => {
  it("appears when the viewer is a live participant, the store confirms the call, and the local call is idle", () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    renderBar()
    expect(screen.getByText(/still in this call/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()
  })

  it("Rejoin dispatches the launch flow with the call's mode, asking to take the endpoint back", async () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: "Take over" }))
    // The bar only shows while a live endpoint the viewer isn't on exists — this
    // tab's own lapsed lease (a rebind) or another device (a takeover).
    expect(launch).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "video",
      expectedCallId: "call_1",
      takeover: true,
    })
  })

  it("Leave posts the self-leave and hides the bar (no zombie lease)", async () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: "Leave" }))
    expect(api.post).toHaveBeenCalledWith("/api/workspaces/ws_1/calls/call_1/leave", {})
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("stays hidden when the viewer is NOT a live participant", () => {
    stubBootstrap({ ...LIVE, selfLiveParticipant: false })
    seedStoreLive()
    renderBar()
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("stays hidden when the active-calls store never confirmed the call (stale bootstrap only)", () => {
    stubBootstrap(LIVE)
    // No seed: the frozen bootstrap says self was live, but the live store has no
    // such call, so the bar must not render a dead Rejoin/Leave.
    renderBar()
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("hides when the store drops the call mid-session (call ended)", () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    renderBar()
    expect(screen.getByText(/still in this call/i)).toBeTruthy()
    act(() => removeActiveCall("ws_1", "call_1"))
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("stays hidden while the local call is active on THIS stream (not a cold load)", () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("connected")
    vi.spyOn(callHooksModule, "useCallStreamId").mockReturnValue("stream_1")
    renderBar()
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("still shows when the local call is active on a DIFFERENT stream (zombie lease here)", () => {
    stubBootstrap(LIVE)
    seedStoreLive()
    vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("connected")
    vi.spyOn(callHooksModule, "useCallStreamId").mockReturnValue("stream_other")
    renderBar()
    expect(screen.getByText(/still in this call/i)).toBeTruthy()
  })
})
