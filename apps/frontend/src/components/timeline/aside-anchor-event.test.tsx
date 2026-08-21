import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { StreamTypes, type StreamEvent } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { createMockStream } from "@/test/fixtures"
import { groupTimelineItems, TimelineItemContent, type TimelineItemRenderContext } from "./event-list"

const CREATOR = "usr_creator"
const OTHER = "usr_other"
const ASIDE = "stream_aside_1"

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

/** The timeline as one viewer sees it: the author gate runs in grouping, the row renders through the real item path. */
function renderTimeline(events: StreamEvent[], viewerId: string) {
  const items = groupTimelineItems(events, viewerId)
  return render(
    <>
      {items.map((item, index) => (
        <TimelineItemContent key={index} item={item} ctx={ctx} deferSecondaryHydration={false} />
      ))}
    </>
  )
}

beforeEach(() => {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([aside] as never)
})

afterEach(() => vi.restoreAllMocks())

describe("AsideAnchorEvent", () => {
  it("renders the creator's row: title joined from the aside stream, age, and a Resume affordance", () => {
    renderTimeline([anchorEvent()], CREATOR)

    const row = document.querySelector('[data-event-id="evt_aside"]')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent("churn number sanity-check")
    expect(row).toHaveTextContent("9m ago")
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument()
    expect(row?.querySelector("[data-aside-id]")).toHaveAttribute("data-aside-id", ASIDE)
  })

  it("renders nothing for another viewer of the same host stream", () => {
    renderTimeline([anchorEvent()], OTHER)

    expect(document.querySelector('[data-event-id="evt_aside"]')).toBeNull()
    expect(screen.queryByText("churn number sanity-check")).toBeNull()
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull()
  })

  it("leaves no row once the aside is archived (joined state, no new event)", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
      { ...aside, archivedAt: "2026-08-20T10:00:00.000Z" },
    ] as never)
    renderTimeline([anchorEvent()], CREATOR)

    expect(screen.queryByText("churn number sanity-check")).toBeNull()
    expect(document.querySelector("[data-aside-id]")).toBeNull()
  })

  it("still draws the row with the type's fallback label before the aside stream is cached", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
    renderTimeline([anchorEvent()], CREATOR)

    expect(document.querySelector("[data-aside-id]")).toHaveTextContent("Aside")
  })
})
