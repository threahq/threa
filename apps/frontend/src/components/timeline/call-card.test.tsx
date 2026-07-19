import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CallEndedEventPayload, CallStartedEventPayload, StreamEvent } from "@threa/types"
import * as hooksModule from "@/hooks"
import * as launchModule from "@/components/call/call-launch-context"
import * as callHooksModule from "@/components/call/call-store-hooks"
import { upsertActiveCall, __resetActiveCallsStore } from "@/stores/active-calls-store"
import { CallCard } from "./call-card"

const launch = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  __resetActiveCallsStore()
  launch.mockClear()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ada",
    getActorAvatar: () => ({ fallback: "A" }),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(launchModule, "useCallLaunch").mockReturnValue({
    launch,
    callActive: false,
  } as unknown as ReturnType<typeof launchModule.useCallLaunch>)
  vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("idle")
  vi.spyOn(callHooksModule, "useCallStreamId").mockReturnValue(null)
})

const STARTED: CallStartedEventPayload = {
  callId: "call_1",
  mode: "video",
  startedBy: "usr_a",
  startedAt: new Date().toISOString(),
}

function startedEvent(): StreamEvent {
  return {
    id: "evt_call",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "call_started",
    actorId: "usr_a",
    actorType: "user",
    createdAt: new Date().toISOString(),
    payload: STARTED,
  }
}

function renderCard(endedPatch?: CallEndedEventPayload) {
  return render(<CallCard event={startedEvent()} workspaceId="ws_1" streamId="stream_1" endedPatch={endedPatch} />)
}

describe("CallCard", () => {
  it("liveness defaults dead: with no live-call cache entry it renders ENDED, no Join button", () => {
    const ended: CallEndedEventPayload = {
      callId: "call_1",
      durationMs: 65_000,
      participantUserIds: ["usr_a", "usr_b"],
      endedReason: "completed",
    }
    renderCard(ended)
    expect(screen.getByText(/Call ended/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull()
  })

  it("renders live and dispatches Join when the active-calls cache confirms the call", async () => {
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    renderCard()
    expect(screen.getByText("Call in progress")).toBeTruthy()
    const join = screen.getByRole("button", { name: "Join" })
    await userEvent.click(join)
    expect(launch).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "video",
      expectedCallId: "call_1",
    })
  })

  it("disables Join with an explanatory tooltip when the viewer is busy on another call", () => {
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    vi.spyOn(launchModule, "useCallLaunch").mockReturnValue({
      launch,
      callActive: true,
    } as unknown as ReturnType<typeof launchModule.useCallLaunch>)
    renderCard()
    const join = screen.getByRole("button", { name: "Join" })
    expect(join.hasAttribute("disabled")).toBe(true)
    expect(join.getAttribute("title")).toMatch(/already in another call/i)
  })

  it("shows 'In this call' instead of Join when the viewer's own session is on this stream", () => {
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    vi.spyOn(callHooksModule, "useCallPhase").mockReturnValue("connected")
    vi.spyOn(callHooksModule, "useCallStreamId").mockReturnValue("stream_1")
    renderCard()
    expect(screen.getByText("In this call")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull()
  })
})
