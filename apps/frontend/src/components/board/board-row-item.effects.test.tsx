import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { StreamEvent } from "@threa/types"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import {
  upsertAgentSession,
  updateAgentSessionProgress,
  __resetAgentActivityStore,
} from "@/stores/agent-activity-store"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as relativeTimeModule from "@/components/relative-time"
import { BoardEventRowItem } from "./board-row-item"

function sessionEvent(eventType: StreamEvent["eventType"], payload: unknown): StreamEvent {
  return {
    id: `event_${eventType}`,
    streamId: "stream_1",
    sequence: "1",
    eventType,
    payload,
    actorId: "persona_1",
    actorType: "persona",
    createdAt: "2026-02-19T18:00:00.000Z",
  }
}

// A terminal board session renders the shared timeline card with no extra
// providers, so the grid must behave identically here — this is the surface
// that calls `AgentSessionEvent` with `events` only.
describe("BoardEventRowItem session effects", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "useTrace").mockReturnValue({
      getTraceUrl: (sessionId: string) => `/trace/${sessionId}`,
    } as ReturnType<typeof contextsModule.useTrace>)
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
  })

  it("renders the effect grid without nesting an anchor in the card link", () => {
    const row = {
      kind: "session",
      key: "session:session_fx",
      sortMs: 0,
      streamId: "stream_1",
      events: [
        sessionEvent("agent_session:started", {
          sessionId: "session_fx",
          personaId: "persona_1",
          personaName: "Ariadne",
          triggerMessageId: "msg_1",
          startedAt: "2026-02-19T18:00:00.000Z",
        }),
        sessionEvent("agent_session:completed", {
          sessionId: "session_fx",
          stepCount: 2,
          messageCount: 1,
          duration: 1000,
          effects: [{ kind: "memo", label: "Saved a memo", target: "memo_1" }],
          completedAt: "2026-02-19T18:00:01.000Z",
        }),
      ],
    } as unknown as BoardEventRow

    const { container } = render(
      <MemoryRouter initialEntries={["/w/ws_1/board"]}>
        <Routes>
          <Route path="/w/:workspaceId/board" element={<BoardEventRowItem row={row} workspaceId="ws_1" />} />
        </Routes>
      </MemoryRouter>
    )

    const cardLink = container.querySelector('a[href="/trace/session_fx"]')!
    expect(cardLink.querySelectorAll("a")).toHaveLength(0)
    expect(screen.getByRole("link", { name: /Saved a memo/ })).toHaveAttribute("href", "/w/ws_1/memory?memo=memo_1")
  })
})

// A RUNNING board session is the same live card the timeline mounts — same
// component, live counts/substep read from the agent-activity store by session
// id, same stop/steer affordances — not a board-only summary that only catches
// up at completion.
describe("BoardEventRowItem running session", () => {
  const started = sessionEvent("agent_session:started", {
    sessionId: "session_live",
    personaId: "persona_1",
    personaName: "Ariadne",
    triggerMessageId: "msg_1",
    startedAt: "2026-02-19T18:00:00.000Z",
  })
  const row = {
    kind: "session",
    key: "session:session_live",
    sortMs: 0,
    streamId: "stream_1",
    events: [started],
  } as unknown as BoardEventRow

  beforeEach(() => {
    vi.restoreAllMocks()
    __resetAgentActivityStore()
    vi.spyOn(contextsModule, "useTrace").mockReturnValue({
      getTraceUrl: (sessionId: string) => `/trace/${sessionId}`,
    } as ReturnType<typeof contextsModule.useTrace>)
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null as never)
    vi.spyOn(workspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
  })

  function mount(onRedirectSession?: () => void) {
    return render(
      <MemoryRouter initialEntries={["/w/ws_1/board"]}>
        <Routes>
          <Route
            path="/w/:workspaceId/board"
            element={<BoardEventRowItem row={row} workspaceId="ws_1" onRedirectSession={onRedirectSession} />}
          />
        </Routes>
      </MemoryRouter>
    )
  }

  it("streams the session's live progress instead of waiting for the terminal event", () => {
    upsertAgentSession("ws_1", {
      sessionId: "session_live",
      streamId: "stream_1",
      rootStreamId: "stream_1",
      personaName: "Ariadne",
      startedAt: "2026-02-19T18:00:00.000Z",
    })
    updateAgentSessionProgress("ws_1", "session_live", {
      stepCount: 4,
      messageCount: 1,
      substep: "Updating your notification settings",
    })
    const stop = vi.fn()
    vi.spyOn(hooksModule, "useStopAgentSession").mockReturnValue(stop as never)
    vi.spyOn(hooksModule, "useSteerAgentSession").mockReturnValue(vi.fn() as never)
    mount()

    // Mid-run, off the socket rail — the terminal payload has not landed.
    expect(screen.getByText("Updating your notification settings")).toBeInTheDocument()
    expect(screen.getByText(/4 steps/)).toBeInTheDocument()
    // And the run stays steerable from the board.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Redirect" })).toBeInTheDocument()
  })

  it("stops the running session through the board's own wiring", async () => {
    const stop = vi.fn()
    vi.spyOn(hooksModule, "useStopAgentSession").mockReturnValue(stop as never)
    vi.spyOn(hooksModule, "useSteerAgentSession").mockReturnValue(vi.fn() as never)
    const onRedirect = vi.fn()
    mount(onRedirect)

    await userEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(stop).toHaveBeenCalledWith("session_live")

    await userEvent.click(screen.getByRole("button", { name: "Redirect" }))
    expect(onRedirect).toHaveBeenCalled()
  })
})
