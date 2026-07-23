import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { CallEndedEventPayload, CallStartedEventPayload, StreamEvent } from "@threa/types"
import * as hooksModule from "@/hooks"
import { PanelProvider } from "@/contexts"
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

function startedEvent(
  payloadExtra?: Partial<CallStartedEventPayload> & { threadId?: string; replyCount?: number }
): StreamEvent {
  return {
    id: "evt_call",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "call_started",
    actorId: "usr_a",
    actorType: "user",
    createdAt: new Date().toISOString(),
    payload: { ...STARTED, ...payloadExtra },
  }
}

function renderCard(endedPatch?: CallEndedEventPayload, event: StreamEvent = startedEvent()) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
      <PanelProvider>
        <CallCard event={event} workspaceId="ws_1" streamId="stream_1" endedPatch={endedPatch} />
      </PanelProvider>
    </MemoryRouter>
  )
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
    expect(join).toHaveClass("min-h-9")
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

  it("shows a Chat affordance opening the draft thread on the call_started event when no replies exist", () => {
    renderCard(
      { callId: "call_1", durationMs: 1000, participantUserIds: ["usr_a"], endedReason: "completed" },
      startedEvent()
    )
    const chat = screen.getByRole("link", { name: /Discuss this call/i })
    // Draft panel keyed on the card's event id — the call chat anchor.
    expect(chat.getAttribute("href")).toContain("draft%3Astream_1%3Aevt_call")
    expect(chat).toHaveClass("min-h-9", "min-w-9")
  })

  it("renders the thread chip and hides Chat once the call has replies (live and ended)", () => {
    // Ended card with a healed thread on its event: chip shows, Chat is the
    // duplicate entry point so it's hidden.
    renderCard(
      { callId: "call_1", durationMs: 1000, participantUserIds: ["usr_a"], endedReason: "completed" },
      startedEvent({ threadId: "stream_thread", replyCount: 2 })
    )
    expect(screen.getByText("2 replies")).toBeTruthy()
    expect(screen.queryByRole("link", { name: /Discuss this call/i })).toBeNull()
  })
})
