import { describe, test, expect, mock } from "bun:test"
import { resolveNotificationLevelsForStream } from "./notification-resolver"
import type { Stream } from "./repository"
import type { StreamMember } from "./member-repository"
import type { Querier } from "../../db"

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: "stream_channel",
    parentMessageId: "msg_1",
    rootStreamId: "stream_channel",
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "member_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function makeMembership(overrides: Partial<StreamMember> = {}): StreamMember {
  return {
    streamId: "stream_thread",
    memberId: "member_1",
    notificationLevel: null,
    lastReadEventId: null,
    lastReadAt: null,
    joinedAt: new Date(),
    ...overrides,
  }
}

/**
 * Create a mock db that returns pre-configured results for sequential query calls.
 * Call 1 = getAncestorIds CTE, Call 2 = getAncestorMemberships batch.
 */
function makeDb(responses: { rows: Record<string, unknown>[] }[]): Querier {
  const queryFn = mock(() => Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 0 }))
  for (const response of responses) {
    queryFn.mockResolvedValueOnce({ rows: response.rows, rowCount: response.rows.length })
  }
  return { query: queryFn } as unknown as Querier
}

describe("resolveNotificationLevelsForStream", () => {
  test("should resolve all explicit members without ancestry queries", async () => {
    const stream = makeStream({ type: "channel", parentStreamId: null })
    const members = [
      makeMembership({ memberId: "member_1", notificationLevel: "everything" }),
      makeMembership({ memberId: "member_2", notificationLevel: "muted" }),
    ]

    const db = makeDb([])

    const results = await resolveNotificationLevelsForStream(db, stream, members)

    expect(results).toEqual([
      { memberId: "member_1", effectiveLevel: "everything", source: "explicit" },
      { memberId: "member_2", effectiveLevel: "muted", source: "explicit" },
    ])
    // No queries needed — all explicit
    expect(db.query).not.toHaveBeenCalled()
  })

  test("should fall back to defaults when no ancestors exist", async () => {
    const stream = makeStream({ type: "channel", parentStreamId: null })
    const members = [
      makeMembership({ memberId: "member_1", notificationLevel: null }),
      makeMembership({ memberId: "member_2", notificationLevel: null }),
    ]

    const db = makeDb([])

    const results = await resolveNotificationLevelsForStream(db, stream, members)

    expect(results).toEqual([
      { memberId: "member_1", effectiveLevel: "mentions", source: "default" },
      { memberId: "member_2", effectiveLevel: "mentions", source: "default" },
    ])
    // parentStreamId is null → getAncestorIds short-circuits, no queries
    expect(db.query).not.toHaveBeenCalled()
  })

  test("should batch-resolve inheritance from parent stream", async () => {
    const threadStream = makeStream({ type: "thread", parentStreamId: "stream_channel" })

    const members = [
      makeMembership({ memberId: "member_1", notificationLevel: null }),
      makeMembership({ memberId: "member_2", notificationLevel: "muted" }),
      makeMembership({ memberId: "member_3", notificationLevel: null }),
    ]

    const db = makeDb([
      // getAncestorIds: returns parent channel
      { rows: [{ id: "stream_channel" }] },
      // getAncestorMemberships: member_1 has "everything" on parent, member_3 has no level
      { rows: [{ stream_id: "stream_channel", member_id: "member_1", notification_level: "everything" }] },
    ])

    const results = await resolveNotificationLevelsForStream(db, threadStream, members)

    const byMember = new Map(results.map((r) => [r.memberId, r]))

    // member_2: explicit muted (never hits DB)
    expect(byMember.get("member_2")).toMatchObject({ effectiveLevel: "muted", source: "explicit" })
    // member_1: inherits everything → activity
    expect(byMember.get("member_1")).toMatchObject({ effectiveLevel: "activity", source: "inherited" })
    // member_3: no parent level, falls to default
    expect(byMember.get("member_3")).toMatchObject({ effectiveLevel: "activity", source: "default" })
  })

  test("should return empty array for empty members", async () => {
    const stream = makeStream()
    const db = makeDb([])
    const results = await resolveNotificationLevelsForStream(db, stream, [])
    expect(results).toEqual([])
  })
})
