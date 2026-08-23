import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { StreamTypes, type StreamEvent } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as eventItemModule from "./event-item"
import { spyOnExport } from "@/test"
import { getAsideState, openAside, resetAsideStoreCache, setAsideSurface, closeAside } from "@/stores/aside-store"
import { createMockStream } from "@/test/fixtures"
import { groupTimelineItems, TimelineItemContent, type TimelineItemRenderContext } from "./event-list"

const CREATOR = "usr_creator"
const OTHER = "usr_other"
const ASIDE = "stream_aside_1"
const HOST_PATH = "/w/ws_1/s/stream_host"

const aside = createMockStream({
  id: ASIDE,
  type: StreamTypes.ASIDE,
  displayName: "churn number sanity-check",
  createdBy: CREATOR,
  parentStreamId: "stream_host",
})

function anchorEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: "evt_aside",
    streamId: "stream_host",
    sequence: "7",
    broadcastSequence: null,
    eventType: "aside:anchored",
    payload: { asideId: ASIDE, anchorId: "msg_1" },
    actorId: CREATOR,
    actorType: "user",
    createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    ...overrides,
  }
}

const ctx: TimelineItemRenderContext = {
  workspaceId: "ws_1",
  streamId: "stream_host",
  sessionLiveCounts: new Map(),
  sessionLiveSubsteps: new Map(),
  cancelledFollowUpIds: new Set(),
  delegationStatusPatches: new Map(),
  botAccessStatusPatches: new Map(),
  callEndedPatches: new Map(),
}

/**
 * The timeline as one viewer sees it: the author gate runs in grouping, the
 * row renders through the real item path. Each item gets its own wrapper, the
 * way the virtualizer gives each item its own cell.
 */
function renderTimeline(events: StreamEvent[], viewerId: string) {
  const items = groupTimelineItems(events, viewerId)
  return render(
    <MemoryRouter initialEntries={[HOST_PATH]}>
      {items.map((item, index) => (
        <div key={index} data-testid={`item-${index}`}>
          <TimelineItemContent item={item} ctx={ctx} deferSecondaryHydration={false} />
        </div>
      ))}
    </MemoryRouter>
  )
}

/** A card the row can anchor to that renders without the message stack's providers. */
function cardEvent(id: string, sequence: string): StreamEvent {
  return {
    id,
    streamId: "stream_host",
    sequence,
    broadcastSequence: sequence,
    eventType: "call_started",
    payload: { callId: `call_${id}`, mode: "audio_only", startedBy: CREATOR, startedAt: "2026-08-20T10:00:00.000Z" },
    actorId: CREATOR,
    actorType: "user",
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  }
}

beforeEach(() => {
  resetAsideStoreCache()
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([aside] as never)
})

afterEach(() => vi.restoreAllMocks())

describe("AsideAnchorEvent", () => {
  it("renders the creator's row: title joined from the aside stream, age, and the resume control", () => {
    renderTimeline([anchorEvent()], CREATOR)

    const row = document.querySelector('[data-event-id="evt_aside"]')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent("churn number sanity-check")
    expect(row).toHaveTextContent("9m ago")
    expect(row?.querySelector("[data-aside-id]")).toHaveAttribute("data-aside-id", ASIDE)
    expect(row?.querySelector("[data-aside-id]")).toHaveAttribute("data-state", "closed")
    expect(screen.getByRole("button", { name: "Resume" })).toHaveClass("opacity-0")
  })

  it("renders nothing for another viewer of the same host stream", () => {
    renderTimeline([anchorEvent()], OTHER)

    expect(document.querySelector('[data-event-id="evt_aside"]')).toBeNull()
    expect(screen.queryByText("churn number sanity-check")).toBeNull()
  })

  it("leaves no row once the aside is archived (joined state, no new event)", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      { ...aside, archivedAt: "2026-08-20T10:00:00.000Z" },
    ] as never)
    renderTimeline([anchorEvent()], CREATOR)

    expect(screen.queryByText("churn number sanity-check")).toBeNull()
    expect(document.querySelector("[data-aside-id]")).toBeNull()
  })

  it("renders inside its anchor's cell when the anchor is in the window — no cell of its own", () => {
    // The anchor card's own body needs the call providers; a marker stands in
    // for it, the folded row still renders through the real item path.
    spyOnExport(eventItemModule, "EventItem").mockReturnValue(((props: { event: StreamEvent }) => (
      <div data-event-id={props.event.id} />
    )) as never)
    renderTimeline(
      [
        cardEvent("evt_call", "1"),
        cardEvent("evt_other", "2"),
        anchorEvent({ payload: { asideId: ASIDE, anchorId: "evt_call" } }),
      ],
      CREATOR
    )

    expect(screen.queryByTestId("item-2")).toBeNull()
    const first = screen.getByTestId("item-0")
    expect(first.querySelector("[data-aside-id]")).toHaveTextContent("churn number sanity-check")
    expect(first.querySelector("[data-event-id='evt_call']")).not.toBeNull()
    expect(screen.getByTestId("item-1").querySelector("[data-aside-id]")).toBeNull()
  })

  it("still draws the row with the type's fallback label before the aside stream is cached", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
    renderTimeline([anchorEvent()], CREATOR)

    expect(document.querySelector("[data-aside-id]")).toHaveTextContent("Aside")
  })

  it("resumes the aside on its host page, into the surface it was last read in, and reads as open", () => {
    // A previous session on this aside ended in fullscreen; minimized never counts.
    openAside({ hostKey: HOST_PATH, hostStreamId: "stream_host", asideId: ASIDE, surface: "fullscreen" })
    setAsideSurface("minimized")
    closeAside()
    renderTimeline([anchorEvent()], CREATOR)

    fireEvent.click(screen.getByRole("button", { name: "Resume" }))

    expect(getAsideState()).toEqual({
      hostKey: HOST_PATH,
      hostStreamId: "stream_host",
      asideId: ASIDE,
      surface: "fullscreen",
    })
    expect(document.querySelector("[data-aside-id]")).toHaveAttribute("data-state", "open")
    expect(document.querySelector("[data-sonner-toast]")).toBeNull()
  })
})
