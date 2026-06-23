import { describe, expect, it, spyOn, afterEach, mock } from "bun:test"
import { emitActivityCountsForPairs } from "./emit-counts"
import { ActivityRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"

const WS = "ws_test"

describe("emitActivityCountsForPairs", () => {
  afterEach(() => mock.restore())

  it("recomputes each pair and emits one activity:counts per affected user", async () => {
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(
      new Map([
        ["usr_a:stream_1", { mentionCount: 1, totalCount: 3 }],
        ["usr_a:stream_2", { mentionCount: 0, totalCount: 0 }],
        ["usr_b:stream_1", { mentionCount: 0, totalCount: 2 }],
      ])
    )
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)

    await emitActivityCountsForPairs({} as any, WS, [
      { userId: "usr_a", streamId: "stream_1" },
      { userId: "usr_a", streamId: "stream_2" },
      { userId: "usr_b", streamId: "stream_1" },
    ])

    const counts = insert.mock.calls.map((c) => c[2] as any)
    const a = counts.find((p) => p.targetUserId === "usr_a")
    const b = counts.find((p) => p.targetUserId === "usr_b")
    expect(insert.mock.calls.every((c) => c[1] === "activity:counts")).toBe(true)
    expect(a).toMatchObject({
      workspaceId: WS,
      counts: [
        { streamId: "stream_1", mentionCount: 1, activityCount: 3 },
        { streamId: "stream_2", mentionCount: 0, activityCount: 0 },
      ],
    })
    expect(b).toMatchObject({ counts: [{ streamId: "stream_1", mentionCount: 0, activityCount: 2 }] })
  })

  it("dedupes repeated (user, stream) pairs before recomputing", async () => {
    const countSpy = spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(
      new Map([["usr_a:stream_1", { mentionCount: 0, totalCount: 1 }]])
    )
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)

    await emitActivityCountsForPairs({} as any, WS, [
      { userId: "usr_a", streamId: "stream_1" },
      { userId: "usr_a", streamId: "stream_1" },
    ])

    expect(countSpy.mock.calls[0]?.[2]).toEqual([{ userId: "usr_a", streamId: "stream_1" }])
    expect(insert.mock.calls.map(([, eventType, payload]) => ({ eventType, payload }))).toEqual([
      {
        eventType: "activity:counts",
        payload: {
          workspaceId: WS,
          targetUserId: "usr_a",
          counts: [{ streamId: "stream_1", mentionCount: 0, activityCount: 1 }],
        },
      },
    ])
  })

  it("emits nothing for an empty pair list", async () => {
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    await emitActivityCountsForPairs({} as any, WS, [])
    expect(insert).not.toHaveBeenCalled()
  })

  it("defaults a pair with no unread rows to zero counts", async () => {
    spyOn(ActivityRepository, "countUnreadForPairs").mockResolvedValue(new Map())
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)

    await emitActivityCountsForPairs({} as any, WS, [{ userId: "usr_a", streamId: "stream_1" }])

    expect(insert.mock.calls[0]?.[2]).toMatchObject({
      targetUserId: "usr_a",
      counts: [{ streamId: "stream_1", mentionCount: 0, activityCount: 0 }],
    })
  })
})
