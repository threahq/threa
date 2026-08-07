import { describe, expect, it, mock } from "bun:test"
import type { Pool } from "pg"
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor"
import { createAgentOutcomeService, statusesForState } from "./service"
import type { AgentOutcomeRow } from "./read-repository"

const NOW = new Date("2026-07-29T10:00:00.000Z")
const NOW_KEY = "2026-07-29T10:00:00.123456Z"

function makeRow(overrides: Partial<AgentOutcomeRow> = {}): AgentOutcomeRow {
  return {
    id: "afu_1",
    kind: "follow_up",
    streamId: "stream_1",
    title: "Check the deploy",
    status: "pending",
    scheduledFor: NOW,
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: NOW,
    statusChangedAt: NOW,
    occursAt: NOW,
    occursAtKey: NOW_KEY,
    anchorEventId: "event_1",
    ...overrides,
  }
}

/** A pool whose one statement returns `rows`, then the count. */
function makePool(rows: AgentOutcomeRow[], count = 0) {
  let call = 0
  const query = mock(async () => {
    call += 1
    if (call === 1) {
      return {
        rows: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          stream_id: r.streamId,
          title: r.title,
          status: r.status,
          scheduled_for: r.scheduledFor,
          claimed_by_label: r.claimedByLabel,
          status_note: r.statusNote,
          result_message_id: r.resultMessageId,
          actor_type: r.actorType,
          actor_id: r.actorId,
          created_at: r.createdAt,
          status_changed_at: r.statusChangedAt,
          occurs_at: r.occursAt,
          occurs_at_key: r.occursAtKey,
          anchor_event_id: r.anchorEventId,
        })),
      }
    }
    return { rows: [{ count }] }
  })
  return { pool: { query } as unknown as Pool, query }
}

describe("statusesForState", () => {
  it("resolves outstanding to the non-terminal statuses of both kinds", () => {
    expect(statusesForState("outstanding")).toEqual({
      followUpStatuses: ["pending"],
      delegationStatuses: ["open", "claimed", "running", "expired"],
    })
  })

  it("resolves settled to the terminal statuses of both kinds", () => {
    expect(statusesForState("settled")).toEqual({
      followUpStatuses: ["fired", "cancelled", "failed"],
      delegationStatuses: ["completed", "failed", "cancelled"],
    })
  })

  it("drops the predicate entirely for all", () => {
    expect(statusesForState("all")).toEqual({})
  })
})

describe("agent outcome service list", () => {
  it("maps rows to the wire shape and counts outstanding on a first page that asked", async () => {
    const service = createAgentOutcomeService({ pool: makePool([makeRow()], 3).pool })

    const response = await service.list({
      workspaceId: "ws_1",
      userId: "usr_1",
      state: "all",
      limit: 10,
      withCount: true,
    })

    expect(response).toEqual({
      items: [
        {
          id: "afu_1",
          kind: "follow_up",
          streamId: "stream_1",
          title: "Check the deploy",
          status: "pending",
          scheduledFor: NOW.toISOString(),
          claimedByLabel: null,
          statusNote: null,
          resultMessageId: null,
          actorType: "persona",
          actorId: "persona_1",
          createdAt: NOW.toISOString(),
          statusChangedAt: NOW.toISOString(),
          occursAt: NOW.toISOString(),
          anchorEventId: "event_1",
        },
      ],
      nextCursor: null,
      outstandingCount: 3,
    })
  })

  it("trims the probe row and emits a cursor from the last visible row's full-precision key", async () => {
    const older = new Date("2026-07-29T09:00:00.000Z")
    const olderKey = "2026-07-29T09:00:00.987654Z"
    const rows = [
      makeRow(),
      makeRow({ id: "dlg_2", kind: "delegation", occursAt: older, occursAtKey: olderKey }),
      makeRow({ id: "afu_3" }),
    ]
    const service = createAgentOutcomeService({ pool: makePool(rows).pool })

    const response = await service.list({ workspaceId: "ws_1", userId: "usr_1", state: "all", limit: 2 })

    expect(response.items.map((i) => i.id)).toEqual(["afu_1", "dlg_2"])
    expect(decodeKeysetCursor(response.nextCursor!)).toEqual({ at: olderKey, id: "dlg_2" })
  })

  it("runs no count query when the caller did not ask for one", async () => {
    const { pool, query } = makePool([makeRow()], 3)
    const service = createAgentOutcomeService({ pool })

    const response = await service.list({ workspaceId: "ws_1", userId: "usr_1", state: "all", limit: 10 })

    expect({ count: response.outstandingCount, queries: query.mock.calls.length }).toEqual({
      count: null,
      queries: 1,
    })
  })

  it("runs no count query on a cursored page even when asked", async () => {
    const { pool, query } = makePool([makeRow()], 3)
    const service = createAgentOutcomeService({ pool })

    const response = await service.list({
      workspaceId: "ws_1",
      userId: "usr_1",
      state: "all",
      limit: 10,
      withCount: true,
      cursor: encodeKeysetCursor({ at: NOW_KEY, id: "afu_0" }),
    })

    expect({ count: response.outstandingCount, queries: query.mock.calls.length }).toEqual({
      count: null,
      queries: 1,
    })
  })

  it("400s a malformed cursor rather than silently resetting to the first page", async () => {
    const service = createAgentOutcomeService({ pool: makePool([]).pool })

    await expect(
      service.list({ workspaceId: "ws_1", userId: "usr_1", state: "all", limit: 10, cursor: "!!!!" })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" })
  })
})
