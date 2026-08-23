import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BOARD_EVENT_ROW_TYPES, type EventType } from "@threa/types"
// eslint-disable-next-line no-restricted-imports -- test builds the rail's own row type, not a component data read
import type { CachedEvent } from "@/db"
import * as hooksModule from "@/hooks"
import * as contextsModule from "@/contexts"
import { PanelProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import { resolveBoardEventRows, type BoardEventRow } from "@/lib/board/board-event-rows"
import { BoardEventRowItem } from "./board-row-item"

const WS = "ws_1"
const STREAM = "stream_1"
const CONV = "conv_1"
const MEMBER_MESSAGE = "msg_member"

let seq = 0
function cachedEvent(eventType: EventType, payload: Record<string, unknown>): CachedEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    workspaceId: WS,
    streamId: STREAM,
    sequence: String(seq),
    _sequenceNum: seq,
    eventType,
    payload,
    actorId: "persona_1",
    actorType: "persona",
    createdAt: `2026-07-04T10:00:0${seq}.000Z`,
    _cachedAt: seq,
  }
}

/**
 * The read half of the anti-drift guard auto-derives from STREAM_ROW_SPEC; the
 * render half cannot, so this fixture map is held to the same spec list. A
 * session's terminal event keeps the row off the live-progress subscription.
 */
const SESSION_FIXTURE: CachedEvent[] = [
  cachedEvent("agent_session:started", {
    sessionId: "sess_1",
    triggerMessageId: MEMBER_MESSAGE,
    personaName: "Ariadne",
  }),
  cachedEvent("agent_session:completed", { sessionId: "sess_1", stepCount: 3, duration: 1200, messageCount: 1 }),
]

const COMMAND_FIXTURE: CachedEvent[] = [
  cachedEvent("command_dispatched", {
    commandId: "cmd_1",
    name: "compact",
    args: "",
    status: "dispatched",
    conversationId: CONV,
  }),
  cachedEvent("command_completed", { commandId: "cmd_1" }),
]

const ROW_FIXTURES: Partial<Record<EventType, CachedEvent[]>> = {
  command_dispatched: COMMAND_FIXTURE,
  command_completed: COMMAND_FIXTURE,
  command_failed: COMMAND_FIXTURE,
  "agent_session:started": SESSION_FIXTURE,
  "agent_session:completed": SESSION_FIXTURE,
  "agent_session:failed": SESSION_FIXTURE,
  "agent_session:interrupted": SESSION_FIXTURE,
  "agent_session:deleted": SESSION_FIXTURE,
  "memos:captured": [
    cachedEvent("memos:captured", {
      conversationId: CONV,
      memos: [{ memoId: "memo_1", title: "Rate limits decided", knowledgeType: "decision", sourceMessageIds: [] }],
    }),
  ],
  "agent:follow_up_scheduled": [
    cachedEvent("agent:follow_up_scheduled", {
      followUpId: "fup_1",
      sourceConversationId: CONV,
      instructions: "Check the deploy",
      scheduledFor: "2026-07-05T10:00:00.000Z",
    }),
  ],
  "delegation:created": [
    cachedEvent("delegation:created", {
      delegationId: "dlg_1",
      title: "Add rate limiting",
      brief: "Token bucket.",
      contextRefs: [],
      sourceConversationId: CONV,
    }),
  ],
  "aside:anchored": [
    cachedEvent("aside:anchored", { asideId: "stream_aside_1", anchorId: MEMBER_MESSAGE, conversationId: CONV }),
  ],
}

function rowsFor(events: CachedEvent[]): BoardEventRow[] {
  return resolveBoardEventRows(events, {
    conversationId: CONV,
    memberMessageIds: new Set([MEMBER_MESSAGE]),
    currentUserId: "persona_1",
  })
}

function renderRow(row: BoardEventRow) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
          <TraceProvider>
            <PanelProvider>
              <BoardEventRowItem row={row} workspaceId={WS} />
            </PanelProvider>
          </TraceProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ariadne",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(false)
  vi.spyOn(hooksModule, "useInputMode").mockReturnValue("mouse")
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

describe("BoardEventRowItem renders every spec-declared board row", () => {
  it("has a fixture for exactly the BOARD_EVENT_ROW_TYPES set", () => {
    expect(new Set(Object.keys(ROW_FIXTURES))).toEqual(new Set(BOARD_EVENT_ROW_TYPES))
  })

  it("renders visible content for every row kind those fixtures resolve to", () => {
    const rendered: Record<string, string[]> = {}
    for (const [type, events] of Object.entries(ROW_FIXTURES)) {
      const kinds: string[] = []
      for (const row of rowsFor(events)) {
        const { container, unmount } = renderRow(row)
        if ((container.textContent ?? "").trim().length > 0) kinds.push(row.kind)
        unmount()
      }
      rendered[type] = kinds
    }
    expect(rendered).toEqual({
      "agent_session:started": ["session"],
      "agent_session:completed": ["session"],
      "agent_session:failed": ["session"],
      "agent_session:interrupted": ["session"],
      "agent_session:deleted": ["session"],
      "memos:captured": ["memo"],
      "agent:follow_up_scheduled": ["followUp"],
      "delegation:created": ["delegation"],
      "aside:anchored": ["aside"],
      command_dispatched: ["command"],
      command_completed: ["command"],
      command_failed: ["command"],
    })
    // A kind that renders nothing produces `[]`, and `[]` can be pasted into the
    // expectation above to make it green. This half names the offending type and
    // cannot be satisfied by editing an expectation.
    expect(Object.entries(rendered).filter(([, kinds]) => kinds.length === 0)).toEqual([])
  })

  it("renders the delegation card with its title and latest status", () => {
    const row = rowsFor([
      ...ROW_FIXTURES["delegation:created"]!,
      cachedEvent("delegation:status_changed", { delegationId: "dlg_1", status: "running" }),
    ])[0]!
    const { container } = renderRow(row)
    expect(container.textContent).toContain("Add rate limiting")
    expect(container.textContent).toContain("Running")
  })
})
