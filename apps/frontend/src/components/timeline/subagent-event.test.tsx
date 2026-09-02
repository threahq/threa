import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import type { StreamEvent, SubagentCreatedEventPayload, SubagentStatus, SubagentSummary } from "@threa/types"
import * as hooksModule from "@/hooks"
import type { MessageAgentActivity } from "@/hooks"
import { PanelProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { subagentsApi } from "@/api"
import { SubagentEvent } from "./subagent-event"

const WS = "ws_1"
const THREAD = "stream_subagent_thread"
const CREATED_AT = "2026-09-01T10:00:00.000Z"
const PATCH_AT = "2026-09-01T10:12:00.000Z"

const CREATED_PAYLOAD: SubagentCreatedEventPayload = {
  subagentId: "subagent_1",
  title: "Second opinion: outbox retry semantics",
  model: "openrouter:anthropic/claude-opus-5",
  personaId: "persona_ariadne",
  threadStreamId: THREAD,
  createdBy: "usr_kris",
  sourceConversationId: "conv_1",
}

function createdEvent(overrides: Partial<SubagentCreatedEventPayload> & { replyCount?: number } = {}): StreamEvent {
  return {
    id: "event_card",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "subagent:created",
    actorId: "persona_ariadne",
    actorType: "persona",
    createdAt: CREATED_AT,
    payload: { ...CREATED_PAYLOAD, ...overrides },
  }
}

function statusPatch(status: SubagentStatus, payload: Record<string, unknown> = {}): StreamEvent {
  return {
    id: `event_patch_${status}`,
    streamId: "stream_1",
    sequence: "21",
    eventType: "subagent:status_changed",
    actorId: "usr_kris",
    actorType: "user",
    createdAt: PATCH_AT,
    payload: { subagentId: CREATED_PAYLOAD.subagentId, status, ...payload },
  }
}

const LIVE_SESSION: MessageAgentActivity = {
  sessionId: "sess_1",
  personaName: "Ariadne",
  currentStepType: "workspace_search",
  stepCount: 2,
  messageCount: 0,
  substep: "reading apps/backend/src/lib/outbox/repository.ts…",
}

function renderCard(props: {
  event?: StreamEvent
  patch?: StreamEvent
  runFallback?: SubagentSummary
  activity?: MessageAgentActivity
  isThreadParent?: boolean
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/w/${WS}/s/stream_1`]}>
          <PanelProvider>
            <SubagentEvent
              event={props.event ?? createdEvent()}
              workspaceId={WS}
              statusPatch={props.patch}
              runFallback={props.runFallback}
              activity={props.activity}
              isThreadParent={props.isThreadParent}
            />
          </PanelProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/**
 * The layout-bearing half of the card's classes. INV-21 is the point of this
 * card's design — one geometry for five states — and jsdom has no layout engine,
 * so the check is structural: the same element tree carrying the same size,
 * spacing and flow classes, with only color and text free to vary.
 */
const LAYOUT_CLASS =
  /^(flex|items-|justify-|gap-|p-|px-|py-|h-\d|w-\d|size-|min-w-|mt-|rounded|border$|shrink|truncate|font-|text-\[)/

function layoutOf(element: Element | null): string {
  if (!element) return "<missing>"
  return [...element.classList]
    .filter((token) => LAYOUT_CLASS.test(token))
    .sort()
    .join(" ")
}

function geometrySignature(container: HTMLElement): string {
  const surface = container.querySelector("a, [class*='rounded-[10px]']")
  const tile = container.querySelector('[data-testid="subagent-tile"]')
  const lines = [...container.querySelectorAll("p")]
  const pill = lines[1]?.parentElement?.nextElementSibling ?? null
  return JSON.stringify({
    surface: layoutOf(surface),
    tile: layoutOf(tile),
    tileIcons: tile?.querySelectorAll("svg").length ?? 0,
    lines: lines.map(layoutOf),
    pill: layoutOf(pill),
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    // Per-id resolution: the card matches a live session's personaName against
    // the run persona's resolved name before claiming the spinner.
    getActorName: (id: string | null) => (id === CREATED_PAYLOAD.personaId ? "Ariadne" : "Kristoffer"),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(false)
  vi.spyOn(hooksModule, "useInputMode").mockReturnValue("mouse")
})

describe("SubagentEvent states", () => {
  it("shows the live substep and a spinner while a session runs", () => {
    const { container } = renderCard({ activity: LIVE_SESSION })

    expect(screen.getByText(CREATED_PAYLOAD.title)).toBeInTheDocument()
    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText(/Claude Opus 5 · reading apps\/backend/)).toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).not.toBeNull()
  })

  it("does not spin for another persona's session in the thread", () => {
    const { container } = renderCard({ activity: { ...LIVE_SESSION, personaName: "Sage" } })

    expect(container.querySelector(".animate-spin")).toBeNull()
    expect(screen.getByText(/starting…/)).toBeInTheDocument()
  })

  it("waits for the reader once the subagent spoke last and no session is live", () => {
    const { container } = renderCard({
      patch: statusPatch("active", { lastAgentMessageAt: PATCH_AT }),
      event: createdEvent({ replyCount: 2 }),
    })

    expect(screen.getByText("Waiting for you")).toBeInTheDocument()
    expect(screen.getByText(/Claude Opus 5 asked a question/)).toBeInTheDocument()
    expect(screen.getByText(/2 replies/)).toBeInTheDocument()
    // Gold is reserved for this state, and nothing moves.
    expect(container.querySelector('[data-testid="subagent-tile"]')?.className).toContain("text-primary")
    expect(container.querySelector(".animate-spin")).toBeNull()
  })

  it("stops waiting — without spinning — when the reader answered last", () => {
    const event = createdEvent()
    ;(event.payload as Record<string, unknown>).threadSummary = {
      lastReplyAt: "2026-09-01T10:20:00.000Z",
      participants: [],
      latestReply: { messageId: "msg_1", actorId: "usr_kris", actorType: "user", contentMarkdown: "yes" },
    }
    const { container } = renderCard({ event, patch: statusPatch("active", { lastAgentMessageAt: PATCH_AT }) })

    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.queryByText("Waiting for you")).not.toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).toBeNull()
  })

  it("reports a failure by its reason code, in words", () => {
    renderCard({ patch: statusPatch("failed", { statusNote: "session_orphaned" }) })

    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.getByText("Claude Opus 5 · the session was lost")).toBeInTheDocument()
  })

  it("names who cancelled a run and strikes the title", () => {
    renderCard({ patch: statusPatch("cancelled") })

    expect(screen.getByText("Cancelled")).toBeInTheDocument()
    expect(screen.getByText(/Cancelled by Kristoffer/)).toBeInTheDocument()
    expect(screen.getByText(CREATED_PAYLOAD.title).className).toContain("line-through")
  })

  it("says a queued run is working without pretending a session is behind it", () => {
    const { container } = renderCard({})

    expect(screen.getByText("Working")).toBeInTheDocument()
    expect(screen.getByText("Claude Opus 5 · starting…")).toBeInTheDocument()
    // The spinner is the claim "a turn is running right now" — never made here.
    expect(container.querySelector(".animate-spin")).toBeNull()
  })

  it("reads the authoritative run when no patch is in reach", () => {
    // A deep link into a finished thread: the parent stream is not cached, so
    // without the run row the card would spin "Working" forever.
    renderCard({
      isThreadParent: true,
      runFallback: {
        id: CREATED_PAYLOAD.subagentId,
        parentStreamId: "stream_1",
        threadStreamId: THREAD,
        cardEventId: "event_card",
        personaId: CREATED_PAYLOAD.personaId,
        model: CREATED_PAYLOAD.model,
        title: CREATED_PAYLOAD.title,
        status: "completed",
        statusNote: null,
        resultMessageId: "msg_result",
        createdAt: CREATED_AT,
        statusChangedAt: PATCH_AT,
      },
    })

    expect(screen.getByText("Done")).toBeInTheDocument()
    expect(screen.queryByText("Working")).not.toBeInTheDocument()
  })

  it("keeps one geometry across every state", () => {
    const renders = [
      renderCard({ activity: LIVE_SESSION }),
      renderCard({}),
      renderCard({ patch: statusPatch("active", { lastAgentMessageAt: PATCH_AT }) }),
      renderCard({ patch: statusPatch("completed", { resultMessageId: "msg_result" }) }),
      renderCard({ patch: statusPatch("failed", { statusNote: "turn_failed" }) }),
      renderCard({ patch: statusPatch("cancelled") }),
      // Cancelled with no patch in reach (the deep-link fallback, and the
      // optimistic flip before the server patch lands): the one state whose
      // meta line could go empty and drop a row.
      renderCard({
        isThreadParent: true,
        runFallback: {
          id: CREATED_PAYLOAD.subagentId,
          parentStreamId: "stream_1",
          threadStreamId: THREAD,
          cardEventId: "event_card",
          personaId: CREATED_PAYLOAD.personaId,
          model: CREATED_PAYLOAD.model,
          title: CREATED_PAYLOAD.title,
          status: "cancelled",
          statusNote: null,
          resultMessageId: null,
          createdAt: CREATED_AT,
          statusChangedAt: PATCH_AT,
        },
      }),
      renderCard({ patch: statusPatch("expired") }),
    ]
    // jsdom has no layout engine: an empty <p> carries the same classes as a
    // full one but paints no line box, so the text check is part of the shape.
    for (const { container } of renders) {
      for (const line of container.querySelectorAll("p")) expect(line.textContent).not.toBe("")
    }
    const signatures = renders.map(({ container }) => geometrySignature(container))

    expect(new Set(signatures).size).toBe(1)
    // A signature that collapsed to nothing would make the set trivially equal.
    const shape = JSON.parse(signatures[0])
    expect(shape.lines).toHaveLength(2)
    expect(shape.tileIcons).toBe(1)
    expect(shape.surface).toBe("border flex gap-3 items-center px-3 py-2 rounded-[10px]")
    expect(shape.tile).toContain("h-7")
  })
})

describe("SubagentEvent actions", () => {
  it("opens the thread from the whole card and from the state's quick action", async () => {
    renderCard({ patch: statusPatch("active", { lastAgentMessageAt: PATCH_AT }) })

    const href = `/w/${WS}/s/stream_1?panel=${THREAD}`
    expect(screen.getByRole("link", { name: /Second opinion/ })).toHaveAttribute("href", href)
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "Answer in thread" })).toHaveAttribute("href", href)
  })

  it("offers View result when the run reported back, and Try again when it did not", async () => {
    const done = renderCard({ patch: statusPatch("completed", { resultMessageId: "msg_result" }) })
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "View result" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Cancel subagent" })).not.toBeInTheDocument()
    done.unmount()

    renderCard({ patch: statusPatch("expired") })
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "Try again" })).toBeInTheDocument()
  })

  it("renders no link when the card is pinned atop its own thread", () => {
    renderCard({ isThreadParent: true, activity: LIVE_SESSION })
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it("flips to cancelled on a won race and defers to the server on a lost one", async () => {
    const cancel = vi.spyOn(subagentsApi, "cancel").mockResolvedValue({ cancelled: true })
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")

    const won = renderCard({ activity: LIVE_SESSION })
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancel subagent" }))
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument())
    expect(cancel).toHaveBeenCalledWith(WS, CREATED_PAYLOAD.subagentId)
    expect(info).not.toHaveBeenCalled()
    won.unmount()

    cancel.mockResolvedValue({ cancelled: false })
    renderCard({ activity: LIVE_SESSION })
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Cancel subagent" }))
    await waitFor(() => expect(info).toHaveBeenCalledWith("This subagent already finished"))
    expect(screen.getByText("Working")).toBeInTheDocument()
  })

  it("flips back to working on a requeue and yields to a newer server patch", async () => {
    const requeue = vi.spyOn(subagentsApi, "requeue").mockResolvedValue({ requeued: true })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (patch: StreamEvent) => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[`/w/${WS}/s/stream_1`]}>
            <PanelProvider>
              <SubagentEvent event={createdEvent()} workspaceId={WS} statusPatch={patch} />
            </PanelProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    )
    const view = render(tree(statusPatch("failed", { statusNote: "turn_failed" })))

    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Try again" }))
    await waitFor(() => expect(screen.getByText("Working")).toBeInTheDocument())
    expect(requeue).toHaveBeenCalledWith(WS, CREATED_PAYLOAD.subagentId)

    // A patch the requeue did not race supersedes the local flip: the server's
    // word is the one on screen.
    view.rerender(tree(statusPatch("cancelled")))
    expect(screen.getByText("Cancelled")).toBeInTheDocument()
    expect(screen.queryByText("Working")).not.toBeInTheDocument()
  })

  it("tells the reader when a requeue finds the run no longer terminal", async () => {
    vi.spyOn(subagentsApi, "requeue").mockResolvedValue({ requeued: false })
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")

    renderCard({ patch: statusPatch("expired") })
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Try again" }))

    await waitFor(() => expect(info).toHaveBeenCalledWith("This subagent is no longer failed or expired"))
    expect(screen.getByText("Expired")).toBeInTheDocument()
  })
})
