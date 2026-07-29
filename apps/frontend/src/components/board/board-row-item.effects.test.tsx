import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { StreamEvent } from "@threa/types"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import * as contextsModule from "@/contexts"
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
