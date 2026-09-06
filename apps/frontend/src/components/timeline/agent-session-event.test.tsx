import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { StreamEvent } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as relativeTimeModule from "@/components/relative-time"
import * as agentTraceModule from "@/hooks/use-agent-trace"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AgentSessionStep } from "@threahq/types"
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

    it("Redirect prepares runtime steering before focusing the surface's composer", async () => {
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
      vi.spyOn(zoneEditor, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 140,
        left: 0,
        right: 300,
      } as DOMRect)
      vi.spyOn(zoneEditor, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 140,
        left: 0,
        right: 300,
      } as DOMRect)

      fireEvent.click(screen.getByRole("button", { name: "Redirect" }))

      expect(onSteerSession).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(focusAtEnd).toHaveBeenCalledWith(zoneEditor))
      expect(screen.getByText("Ariadne will fold your message into the current work")).toBeInTheDocument()
    })

    it("keeps Redirect single-flight while preparing steering and allows a later redirect", async () => {
      const focusAtEnd = vi.spyOn(hooksModule, "focusAtEnd").mockImplementation(() => undefined)
      const onRedirect = vi.fn()
      let finishSteer!: () => void
      let steerCall = 0
      const onSteerSession = vi.fn(() => {
        steerCall += 1
        if (steerCall > 1) return Promise.resolve()
        return new Promise<void>((resolve) => {
          finishSteer = resolve
        })
      })

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

      const redirect = screen.getByRole("button", { name: "Redirect" })
      fireEvent.click(redirect)
      fireEvent.click(redirect)

      expect(onSteerSession).toHaveBeenCalledTimes(1)
      expect(onRedirect).not.toHaveBeenCalled()
      finishSteer()
      await waitFor(() => expect(onRedirect).toHaveBeenCalledTimes(1))

      fireEvent.click(redirect)
      await waitFor(() => expect(onSteerSession).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(onRedirect).toHaveBeenCalledTimes(2))
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

describe("AgentSessionEvent effects", () => {
  function startedEvent(sessionId = "session_fx") {
    return createSessionEvent("agent_session:started", {
      sessionId,
      personaId: "persona_1",
      personaName: "Ariadne",
      triggerMessageId: "msg_1",
      startedAt: "2026-02-19T18:00:00.000Z",
    })
  }

  function completedEvent(effects: unknown[], sessionId = "session_fx") {
    return createSessionEvent("agent_session:completed", {
      sessionId,
      stepCount: 3,
      messageCount: 1,
      duration: 1000,
      effects,
      completedAt: "2026-02-19T18:00:01.000Z",
    })
  }

  // The memo row mounts a `MemoPreviewDialog`, which reads the memo cache, and
  // a running card subscribes through `useAgentTrace` — both need a client.
  function renderInWorkspace(events: StreamEvent[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <Routes>
            <Route path="/w/:workspaceId/s/:streamId" element={<AgentSessionEvent events={events} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  function traceResult(steps: AgentSessionStep[]): ReturnType<typeof agentTraceModule.useAgentTrace> {
    return {
      steps,
      streamingContent: {},
      streamingSubsteps: {},
      session: null,
      relatedSessions: [],
      persona: null,
      status: "running",
      isLoading: false,
      error: null,
    }
  }

  function toolStep(
    stepNumber: number,
    step: Partial<AgentSessionStep> & Pick<AgentSessionStep, "effects">
  ): AgentSessionStep {
    return {
      id: `step_${stepNumber}`,
      sessionId: "session_fx",
      stepNumber,
      stepType: "tool_call",
      startedAt: "2026-02-19T18:00:00.000Z",
      ...step,
    } as AgentSessionStep
  }

  beforeEach(() => {
    vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(traceResult([]))
  })

  it("renders one row per labelled effect", () => {
    renderInWorkspace([
      startedEvent(),
      completedEvent([
        { kind: "memo", label: "Saved a memo", target: "memo_1" },
        { kind: "delegation", label: "Delegated the audit", target: "dlg_1" },
      ]),
    ])

    expect(screen.getByText("Saved a memo")).toBeInTheDocument()
    expect(screen.getByText("Delegated the audit")).toBeInTheDocument()
  })

  it("never nests an anchor inside the card link", () => {
    const { container } = renderInWorkspace([
      startedEvent(),
      completedEvent([{ kind: "memo", label: "Saved a memo", target: "memo_1" }]),
    ])

    const cardLink = container.querySelector('a[href="/trace/session_fx"]')!
    expect(cardLink.querySelectorAll("a")).toHaveLength(0)
    // A memo opens in place, so its row is a button — which must not be nested
    // in the card's <a> either.
    expect(cardLink.querySelectorAll("button")).toHaveLength(0)
    expect(screen.getByRole("button", { name: /Saved a memo/ })).toBeInTheDocument()
  })

  it("spans the last line across both columns on an odd count", () => {
    renderInWorkspace([
      startedEvent(),
      completedEvent([
        { kind: "memo", label: "Memo A", target: "memo_1" },
        { kind: "memo", label: "Memo B", target: "memo_2" },
        { kind: "memo", label: "Memo C", target: "memo_3" },
      ]),
    ])

    expect(screen.getByRole("button", { name: /Memo C/ }).className).toContain("effect-grid-span")
    expect(screen.getByRole("button", { name: /Memo A/ }).className).not.toContain("effect-grid-span")
  })

  it("renders a routeless effect as inert text that cannot be focused", () => {
    renderInWorkspace([
      startedEvent(),
      completedEvent([{ kind: "follow_up", label: "Reminder on Friday", target: "fu_1" }]),
    ])

    const text = screen.getByText("Reminder on Friday")
    expect(text.closest("a")).toBeNull()
    expect(text.closest("[tabindex]")).toBeNull()
    expect(screen.queryByRole("link", { name: /Reminder on Friday/ })).not.toBeInTheDocument()
  })

  it("renders no grid while a running session has written nothing yet", () => {
    renderInWorkspace([startedEvent()])

    expect(screen.queryByText("Saved a memo")).not.toBeInTheDocument()
    expect(screen.getByText(/is working/)).toBeInTheDocument()
  })

  it("renders a running turn's write as soon as its step carries it", async () => {
    vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(
      traceResult([toolStep(1, { effects: [{ kind: "settings", target: "theme", before: "light", after: "dark" }] })])
    )

    renderInWorkspace([startedEvent()])

    expect(await screen.findByText(/dark/)).toBeInTheDocument()
    expect(screen.getByText(/is working/)).toBeInTheDocument()
  })

  it("drops the effects of a step the guardian denied", async () => {
    vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(
      traceResult([
        toolStep(1, { effects: [{ kind: "memo", label: "Allowed memo", target: "memo_1" }] }),
        toolStep(2, {
          effects: [{ kind: "memo", label: "Denied memo", target: "memo_2" }],
          verification: { status: "denied", reason: "no" },
        } as Partial<AgentSessionStep> & Pick<AgentSessionStep, "effects">),
      ])
    )

    renderInWorkspace([startedEvent()])

    expect(await screen.findByText("Allowed memo")).toBeInTheDocument()
    expect(screen.queryByText("Denied memo")).not.toBeInTheDocument()
  })

  // The row on screen may not move when the next one lands (INV-21), and it may
  // not survive into the terminal grid twice.
  it("appends live rows without reordering or dropping the ones already shown", async () => {
    const first = toolStep(1, { effects: [{ kind: "memo", label: "Memo A", target: "memo_1" }] })
    const second = toolStep(2, { effects: [{ kind: "memo", label: "Memo B", target: "memo_2" }] })
    const trace = vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(traceResult([first]))

    const { rerender } = renderInWorkspace([startedEvent()])
    const rowA = await screen.findByRole("button", { name: /Memo A/ })

    // A reconnect empties the realtime map before the refetch lands; the rendered
    // rows must not follow it out.
    trace.mockReturnValue(traceResult([]))
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <Routes>
            <Route path="/w/:workspaceId/s/:streamId" element={<AgentSessionEvent events={[startedEvent()]} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    expect(screen.getByRole("button", { name: /Memo A/ })).toBe(rowA)

    trace.mockReturnValue(traceResult([first, second]))
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <Routes>
            <Route path="/w/:workspaceId/s/:streamId" element={<AgentSessionEvent events={[startedEvent()]} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )

    const rows = await screen.findAllByRole("button", { name: /Memo [AB]/ })
    expect(rows.map((r) => r.textContent)).toEqual(["Memo A›", "Memo B›"])
    expect(rows[0]).toBe(rowA)
  })

  // `retrying` is started + interrupted with no terminal event — an attempt is
  // running RIGHT NOW, so it has to stream too. The earlier attempt's writes only
  // survive on the interrupted payload (the retry's `upsertStep` resets the step's
  // effects), so they seed the grid and the new attempt appends to them.
  it("keeps an interrupted attempt's writes and streams the retry's onto the end", async () => {
    const interrupted = createSessionEvent("agent_session:interrupted", {
      sessionId: "session_fx",
      stepCount: 2,
      attempt: 0,
      maxAttempts: 5,
      error: "Error: boom",
      interruptedAt: "2026-02-19T18:00:05.000Z",
      effects: [{ kind: "memo", label: "Memo A", target: "memo_1" }],
    })
    // The retry re-runs the same tool (same descriptor, so it must NOT double) and
    // then writes something new.
    vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(
      traceResult([
        toolStep(1, { effects: [{ kind: "memo", label: "Memo A", target: "memo_1" }] }),
        toolStep(2, { effects: [{ kind: "memo", label: "Memo B", target: "memo_2" }] }),
      ])
    )

    renderInWorkspace([startedEvent(), interrupted])

    const rows = await screen.findAllByRole("button", { name: /Memo [AB]/ })
    expect(rows.map((r) => r.textContent)).toEqual(["Memo A›", "Memo B›"])
  })

  // The live path is for the in-flight turn only: once the session is terminal
  // the lifecycle payloads take over, and the row must not appear twice.
  it("hands over to the payload union on completion without duplicating a row", async () => {
    vi.spyOn(agentTraceModule, "useAgentTrace").mockReturnValue(
      traceResult([toolStep(1, { effects: [{ kind: "memo", label: "Saved a memo", target: "memo_1" }] })])
    )

    renderInWorkspace([startedEvent(), completedEvent([{ kind: "memo", label: "Saved a memo", target: "memo_1" }])])

    expect(await screen.findAllByRole("button", { name: /Saved a memo/ })).toHaveLength(1)
  })

  // Only a bare `{ kind }` is a layer-0 marker — a mutating tool that declared
  // nothing. There is no label, target or diff to render, so it earns a count
  // and no row.
  it("counts bare layer-0 markers on the meta line instead of adding grid rows", () => {
    renderInWorkspace([startedEvent(), completedEvent([{ kind: "other" }, { kind: "brief" }])])

    expect(screen.getByText(/3 steps • 1\.0s • 1 message sent • 2 changes/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Change/ })).not.toBeInTheDocument()
  })

  // The shape `update_user_settings` actually declares: no label at all, named
  // from its kind, described by target + diff. Filtering the grid on `label`
  // would have dropped the write this whole feature exists to surface.
  it("renders a label-less settings write as a row, not a bare count", () => {
    renderInWorkspace([
      startedEvent(),
      completedEvent([{ kind: "settings", target: "theme", before: "light", after: "dark" }]),
    ])

    expect(screen.getByText(/light/)).toBeInTheDocument()
    expect(screen.getByText(/dark/)).toBeInTheDocument()
    expect(screen.queryByText(/1 change/)).not.toBeInTheDocument()
  })

  // Same shape for the other two tools that describe themselves without a label.
  it("renders a label-less brief version bump as a row", () => {
    renderInWorkspace([startedEvent(), completedEvent([{ kind: "brief", before: "1", after: "2" }])])

    expect(screen.queryByText(/1 change/)).not.toBeInTheDocument()
  })

  it("unions effects across the interrupted and completed payloads, deduped", () => {
    const shared = { kind: "memo", label: "Saved a memo", target: "memo_1" }
    renderInWorkspace([
      startedEvent(),
      createSessionEvent("agent_session:interrupted", {
        sessionId: "session_fx",
        stepCount: 2,
        attempt: 0,
        maxAttempts: 3,
        error: "boom",
        effects: [shared, { kind: "settings", target: "theme", before: "light", after: "dark" }],
        interruptedAt: "2026-02-19T18:00:00.500Z",
      }),
      completedEvent([shared]),
    ])

    expect(screen.getAllByText("Saved a memo")).toHaveLength(1)
    expect(screen.getByText(/dark/)).toBeInTheDocument()
  })

  // The columns are decided by the CONTAINER, not the viewport: a board card is
  // a narrow column inside a wide window, and a viewport breakpoint gave it two
  // 145px columns that clipped every value. jsdom cannot evaluate a container
  // query, so this pins the wiring; the layout itself is checked by screenshot.
  it("sizes its columns from the container, not the viewport", () => {
    const { container } = renderInWorkspace([
      startedEvent(),
      completedEvent([{ kind: "settings", target: "theme", before: "light", after: "dark" }]),
    ])

    expect(container.querySelector(".effect-grid-host")).not.toBeNull()
    expect(container.querySelector(".effect-grid")).not.toBeNull()
    expect(container.querySelector('[class*="sm:grid-cols"]')).toBeNull()
  })

  // A session keeps its id across retries, so a turn that is retried twice
  // emits several interrupted events onto the same card. Each attempt's
  // upsertStep wipes the previous attempt's step effects, so that attempt's
  // interrupted payload is the ONLY surviving record of what it wrote — keeping
  // just the newest one loses every write before the final retry.
  it("keeps effects from every interrupted attempt, not just the last", () => {
    const interrupted = (attempt: number, effects: unknown[], at: string) =>
      createSessionEvent("agent_session:interrupted", {
        sessionId: "session_fx",
        stepCount: 2,
        attempt,
        maxAttempts: 5,
        error: "timeout",
        effects,
        interruptedAt: at,
      })

    renderInWorkspace([
      startedEvent(),
      interrupted(
        0,
        [{ kind: "settings", target: "theme", before: "light", after: "dark" }],
        "2026-02-19T18:00:00.500Z"
      ),
      interrupted(1, [], "2026-02-19T18:00:10.500Z"),
      completedEvent([]),
    ])

    // Attempt 0's write is invisible everywhere else by this point.
    expect(screen.getByText(/light/)).toBeInTheDocument()
    expect(screen.getByText(/dark/)).toBeInTheDocument()
  })
})
