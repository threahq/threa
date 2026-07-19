import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { StreamActiveCall } from "@threa/types"
import * as hooksModule from "@/hooks"
import * as launchModule from "./call-launch-context"
import * as callHooksModule from "./call-store-hooks"
import { api } from "@/api/client"
import { RejoinBar } from "./rejoin-bar"

const launch = vi.fn()

function stubBootstrap(activeCall: StreamActiveCall | null) {
  vi.spyOn(hooksModule, "useStreamBootstrap").mockReturnValue({
    data: { activeCall },
  } as unknown as ReturnType<typeof hooksModule.useStreamBootstrap>)
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
  launch.mockClear()
  vi.spyOn(launchModule, "useCallLaunch").mockReturnValue({
    launch,
  } as unknown as ReturnType<typeof launchModule.useCallLaunch>)
  vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("idle")
  vi.spyOn(api, "post").mockResolvedValue({} as never)
})

function renderBar() {
  return render(<RejoinBar workspaceId="ws_1" streamId="stream_1" />)
}

describe("RejoinBar", () => {
  it("appears when the viewer is still a live participant and the local call is idle", () => {
    stubBootstrap(LIVE)
    renderBar()
    expect(screen.getByText(/still in this call/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Rejoin" })).toBeTruthy()
  })

  it("Rejoin dispatches the launch flow with the call's mode", async () => {
    stubBootstrap(LIVE)
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: "Rejoin" }))
    expect(launch).toHaveBeenCalledWith({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
  })

  it("Leave posts the self-leave and hides the bar (no zombie lease)", async () => {
    stubBootstrap(LIVE)
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: "Leave" }))
    expect(api.post).toHaveBeenCalledWith("/api/workspaces/ws_1/calls/call_1/leave", {})
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("stays hidden when the viewer is NOT a live participant", () => {
    stubBootstrap({ ...LIVE, selfLiveParticipant: false })
    renderBar()
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })

  it("stays hidden while a local call is already active (not a cold load)", () => {
    stubBootstrap(LIVE)
    vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("connected")
    renderBar()
    expect(screen.queryByText(/still in this call/i)).toBeNull()
  })
})
