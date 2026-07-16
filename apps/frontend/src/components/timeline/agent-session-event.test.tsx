import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { StreamEvent } from "@threa/types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as relativeTimeModule from "@/components/relative-time"
import { AgentSessionEvent } from "./agent-session-event"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (sessionId: string) => `/trace/${sessionId}`,
  } as ReturnType<typeof contextsModule.useTrace>)
  vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
})

function createSessionEvent(eventType: StreamEvent["eventType"], payload: unknown): StreamEvent {
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

function renderEvent(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe("AgentSessionEvent", () => {
  it("shows the session version badge", () => {
    const events: StreamEvent[] = [
      createSessionEvent("agent_session:started", {
        sessionId: "session_2",
        personaId: "persona_1",
        personaName: "Ariadne",
        triggerMessageId: "msg_1",
        startedAt: "2026-02-19T18:00:00.000Z",
      }),
      createSessionEvent("agent_session:completed", {
        sessionId: "session_2",
        stepCount: 1,
        messageCount: 1,
        duration: 1000,
        completedAt: "2026-02-19T18:00:01.000Z",
      }),
    ]

    renderEvent(<AgentSessionEvent events={events} sessionVersion={2} />)

    expect(screen.getByText("Version 2")).toBeInTheDocument()
  })

  it("does not show a version badge for the initial invocation", () => {
    const events: StreamEvent[] = [
      createSessionEvent("agent_session:started", {
        sessionId: "session_1",
        personaId: "persona_1",
        personaName: "Ariadne",
        triggerMessageId: "msg_1",
        startedAt: "2026-02-19T18:00:00.000Z",
      }),
      createSessionEvent("agent_session:completed", {
        sessionId: "session_1",
        stepCount: 1,
        messageCount: 1,
        duration: 1000,
        completedAt: "2026-02-19T18:00:01.000Z",
      }),
    ]

    renderEvent(<AgentSessionEvent events={events} sessionVersion={1} />)

    expect(screen.queryByText("Version 1")).not.toBeInTheDocument()
  })

  it("shows rerun reason when session was retriggered by follow-up edit", () => {
    const events: StreamEvent[] = [
      createSessionEvent("agent_session:started", {
        sessionId: "session_3",
        personaId: "persona_1",
        personaName: "Ariadne",
        triggerMessageId: "msg_1",
        rerunContext: {
          cause: "referenced_message_edited",
          editedMessageId: "msg_follow_up_1",
        },
        startedAt: "2026-02-19T18:00:00.000Z",
      }),
      createSessionEvent("agent_session:completed", {
        sessionId: "session_3",
        stepCount: 1,
        messageCount: 1,
        duration: 1000,
        completedAt: "2026-02-19T18:00:01.000Z",
      }),
    ]

    renderEvent(<AgentSessionEvent events={events} sessionVersion={2} />)

    expect(screen.getByText("Rerun after follow-up message edit • 1 step • 1.0s • 1 message sent")).toBeInTheDocument()
  })

  describe("Interrupted / retrying", () => {
    const startedEvent = createSessionEvent("agent_session:started", {
      sessionId: "session_int",
      personaId: "persona_1",
      personaName: "Ariadne",
      triggerMessageId: "msg_1",
      startedAt: "2026-02-19T18:00:00.000Z",
    })
    const interruptedEvent = createSessionEvent("agent_session:interrupted", {
      sessionId: "session_int",
      stepCount: 2,
      attempt: 0,
      maxAttempts: 5,
      error: "Error: boom",
      interruptedAt: "2026-02-19T18:00:05.000Z",
    })

    it("renders the retrying state with the interrupted snapshot step count", () => {
      renderEvent(<AgentSessionEvent events={[startedEvent, interruptedEvent]} />)

      expect(screen.getByText("Interrupted, retrying…")).toBeInTheDocument()
      expect(screen.getByText("2 steps")).toBeInTheDocument()
      expect(screen.queryByText("Session failed")).not.toBeInTheDocument()
    })

    it("follows the live count while the retry is actively progressing", () => {
      // Active retry ticking (its counter restarts from 1) → show the live count so
      // it moves every step instead of freezing at the snapshot and reading as a hang.
      renderEvent(
        <AgentSessionEvent events={[startedEvent, interruptedEvent]} liveCounts={{ stepCount: 1, messageCount: 0 }} />
      )

      expect(screen.getByText("Interrupted, retrying…")).toBeInTheDocument()
      expect(screen.getByText("1 step")).toBeInTheDocument()
    })

    it("falls back to the snapshot when the live rail reports 0 (backoff)", () => {
      renderEvent(
        <AgentSessionEvent events={[startedEvent, interruptedEvent]} liveCounts={{ stepCount: 0, messageCount: 0 }} />
      )

      expect(screen.getByText("2 steps")).toBeInTheDocument()
    })

    it("shows no Stop/Redirect actions while retrying (not running)", () => {
      renderEvent(<AgentSessionEvent events={[startedEvent, interruptedEvent]} onStopSession={vi.fn()} />)

      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Redirect" })).not.toBeInTheDocument()
    })

    it("a later completed supersedes the interrupt (the successful retry wins)", () => {
      const completedEvent = createSessionEvent("agent_session:completed", {
        sessionId: "session_int",
        stepCount: 3,
        messageCount: 1,
        duration: 1000,
        completedAt: "2026-02-19T18:00:09.000Z",
      })

      renderEvent(<AgentSessionEvent events={[startedEvent, interruptedEvent, completedEvent]} />)

      expect(screen.getByText("Session complete")).toBeInTheDocument()
      expect(screen.queryByText("Interrupted, retrying…")).not.toBeInTheDocument()
    })

    it("a terminal failed supersedes the interrupt (retries exhausted)", () => {
      const failedEvent = createSessionEvent("agent_session:failed", {
        sessionId: "session_int",
        stepCount: 2,
        error: "Error: boom",
        traceId: "session_int",
        failedAt: "2026-02-19T18:00:09.000Z",
      })

      renderEvent(<AgentSessionEvent events={[startedEvent, interruptedEvent, failedEvent]} />)

      expect(screen.getByText("Session failed")).toBeInTheDocument()
      expect(screen.queryByText("Interrupted, retrying…")).not.toBeInTheDocument()
    })
  })

  describe("Stop / Redirect actions", () => {
    const runningEvents: StreamEvent[] = [
      createSessionEvent("agent_session:started", {
        sessionId: "session_run",
        personaId: "persona_1",
        personaName: "Ariadne",
        triggerMessageId: "msg_1",
        startedAt: "2026-02-19T18:00:00.000Z",
      }),
    ]

    it("renders both buttons while the session is running", () => {
      renderEvent(<AgentSessionEvent events={runningEvents} onStopSession={vi.fn()} />)

      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Redirect" })).toBeInTheDocument()
    })

    it("renders neither button once the session is terminal", () => {
      const events: StreamEvent[] = [
        ...runningEvents,
        createSessionEvent("agent_session:completed", {
          sessionId: "session_run",
          stepCount: 1,
          messageCount: 1,
          duration: 1000,
          completedAt: "2026-02-19T18:00:01.000Z",
        }),
      ]

      renderEvent(<AgentSessionEvent events={events} onStopSession={vi.fn()} />)

      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Redirect" })).not.toBeInTheDocument()
    })

    it("Stop calls the abort handler with the session id", () => {
      const onStopSession = vi.fn()
      renderEvent(<AgentSessionEvent events={runningEvents} onStopSession={onStopSession} />)

      fireEvent.click(screen.getByRole("button", { name: "Stop" }))

      expect(onStopSession).toHaveBeenCalledWith("session_run")
    })

    it("Redirect prepares runtime steering, focuses the surface's composer, and shows the fold-in hint", () => {
      const focusAtEnd = vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)
      const onSteerSession = vi.fn()

      render(
        <div data-editor-zone="main">
          <MemoryRouter>
            <AgentSessionEvent events={runningEvents} onStopSession={vi.fn()} onSteerSession={onSteerSession} />
          </MemoryRouter>
          <div data-testid="zone-editor" contentEditable />
        </div>
      )

      // jsdom reports empty client rects; mock the editor as visible so
      // focusVisibleZoneEditor picks it.
      const zoneEditor = screen.getByTestId("zone-editor")
      const rects = {
        length: 1,
        item: (index: number) => (index === 0 ? ({ width: 1, height: 1 } as DOMRect) : null),
        0: { width: 1, height: 1 } as DOMRect,
      } as unknown as DOMRectList
      vi.spyOn(zoneEditor, "getClientRects").mockReturnValue(rects)

      fireEvent.click(screen.getByRole("button", { name: "Redirect" }))

      expect(onSteerSession).toHaveBeenCalledTimes(1)
      expect(focusAtEnd).toHaveBeenCalledWith(zoneEditor)
      expect(screen.getByText("Ariadne will fold your message into the current work")).toBeInTheDocument()
    })

    it("Redirect calls onRedirect (board card) instead of walking the DOM, and shows the hint", () => {
      const focusAtEnd = vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)
      const onRedirect = vi.fn()
      const onSteerSession = vi.fn()

      // No [data-editor-zone] in the tree — the board card has none; the surface
      // owns opening + focusing its own composer via onRedirect.
      renderEvent(
        <AgentSessionEvent
          events={runningEvents}
          onStopSession={vi.fn()}
          onRedirect={onRedirect}
          onSteerSession={onSteerSession}
        />
      )

      fireEvent.click(screen.getByRole("button", { name: "Redirect" }))

      expect(onRedirect).toHaveBeenCalledTimes(1)
      expect(onSteerSession).toHaveBeenCalledTimes(1)
      expect(focusAtEnd).not.toHaveBeenCalled()
      expect(screen.getByText("Ariadne will fold your message into the current work")).toBeInTheDocument()
    })

    it("Redirect shows no hint when the surface has no composer", () => {
      const focusAtEnd = vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)

      // A zone with no contenteditable — e.g. a non-member viewing a public
      // channel, or an archived stream with the composer replaced by a notice.
      render(
        <div data-editor-zone="main">
          <MemoryRouter>
            <AgentSessionEvent events={runningEvents} onStopSession={vi.fn()} />
          </MemoryRouter>
        </div>
      )

      fireEvent.click(screen.getByRole("button", { name: "Redirect" }))

      expect(focusAtEnd).not.toHaveBeenCalled()
      expect(screen.queryByText("Ariadne will fold your message into the current work")).not.toBeInTheDocument()
    })
  })
})
