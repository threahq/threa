import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { CallEndedEventPayload, CallStartedEventPayload, StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import { PanelProvider } from "@/contexts"
import * as launchModule from "@/components/call/call-launch-context"
import * as callHooksModule from "@/components/call/call-store-hooks"
import * as anotherDeviceModule from "@/components/call/use-call-on-another-device"
import { upsertActiveCall, __resetActiveCallsStore } from "@/stores/active-calls-store"
import { CallCard } from "./call-card"

const launch = vi.fn()

afterEach(() => vi.useRealTimers())

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
  // Default: the viewer is not in this call anywhere. The take-over case flips it.
  vi.spyOn(anotherDeviceModule, "useCallOnAnotherDevice").mockReturnValue(false)
  vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(false)
  vi.spyOn(hooksModule, "useInputMode").mockReturnValue("mouse")
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

function renderCard(endedPatch?: CallEndedEventPayload, event: StreamEvent = startedEvent(), isThreadParent?: boolean) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
      <PanelProvider>
        <CallCard
          event={event}
          workspaceId="ws_1"
          streamId="stream_1"
          endedPatch={endedPatch}
          isThreadParent={isThreadParent}
        />
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
      takeover: false,
    })
  })

  it("offers Take over instead of Join when the viewer holds this call on another device", async () => {
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    vi.spyOn(anotherDeviceModule, "useCallOnAnotherDevice").mockReturnValue(true)
    renderCard()

    // The card says what will happen BEFORE the click — no Join that 409s and
    // then asks for confirmation.
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Take over" }))
    expect(launch).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "video",
      expectedCallId: "call_1",
      takeover: true,
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

  it("shows a desktop quick action opening draft call chat on the call_started event", () => {
    renderCard(
      { callId: "call_1", durationMs: 1000, participantUserIds: ["usr_a"], endedReason: "completed" },
      startedEvent()
    )
    const chat = screen.getByRole("link", { name: "Start call chat" })
    expect(chat.getAttribute("href")).toContain("draft%3Astream_1%3Aevt_call")
  })

  it("keeps call chat in the quick toolbar when the reply chip is present", () => {
    renderCard(
      { callId: "call_1", durationMs: 1000, participantUserIds: ["usr_a"], endedReason: "completed" },
      startedEvent({ threadId: "stream_thread", replyCount: 2 })
    )
    expect(screen.getByText("2 replies")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open call chat" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?panel=stream_thread"
    )
  })

  it("as thread parent: suppresses the reply chip AND Chat (would loop back to the open panel)", () => {
    renderCard(
      { callId: "call_1", durationMs: 1000, participantUserIds: ["usr_a"], endedReason: "completed" },
      startedEvent({ threadId: "stream_thread", replyCount: 2 }),
      true
    )
    expect(screen.queryByText("2 replies")).toBeNull()
    expect(screen.queryByRole("link", { name: /call chat/i })).toBeNull()
  })

  it("offers Join, chat, and copy link from the desktop row context menu", async () => {
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    renderCard()

    fireEvent.contextMenu(screen.getByText("Call in progress"))

    expect(await screen.findByRole("menuitem", { name: "Join call" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Start call chat" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Copy link to call" })).toBeInTheDocument()
  })

  it("opens the mobile action drawer on long press while keeping Join on the card", () => {
    vi.useFakeTimers()
    vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(true)
    vi.spyOn(hooksModule, "useInputMode").mockReturnValue("touch")
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    renderCard()

    const join = screen.getByRole("button", { name: "Join" })
    expect(join).toHaveClass("min-h-9")
    const title = screen.getByText("Call in progress")
    fireEvent.touchStart(title, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.getByRole("button", { name: "Join call" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Start call chat" })).toBeInTheDocument()
  })

  it("holding Join does not open the card drawer", () => {
    vi.useFakeTimers()
    vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(true)
    vi.spyOn(hooksModule, "useInputMode").mockReturnValue("touch")
    upsertActiveCall("ws_1", {
      callId: "call_1",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      mode: "video",
      participantCount: 1,
      participantUserIds: ["usr_a"],
    })
    renderCard()

    const join = screen.getByRole("button", { name: "Join" })
    fireEvent.touchStart(join, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.queryByRole("button", { name: "Join call" })).not.toBeInTheDocument()
  })
})
