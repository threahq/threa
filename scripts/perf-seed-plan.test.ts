import { describe, expect, test } from "bun:test"
import {
  BOARD_LARGE_MESSAGES_PER_STREAM,
  BOARD_LARGE_STREAM_COUNT,
  DRAFT_PROFILE_SIZES,
  UnknownPerfProfileError,
  messageContent,
  messagesForMissedEntries,
  parseProfile,
  planSeed,
  seedSpec,
  WORKSPACE_WIDE_MESSAGES_PER_STREAM,
  WORKSPACE_WIDE_STREAM_COUNT,
  type ExistingState,
} from "./lib/perf-seed-plan"

const wideKey = (i: number) => `perf-wide-${String(i + 1).padStart(2, "0")}`

const empty: ExistingState = { messageCounts: {} }

describe("parseProfile", () => {
  test("accepts each fixed profile", () => {
    expect(parseProfile("large-stream")).toEqual({ name: "large-stream" })
    expect(parseProfile("thread-2000")).toEqual({ name: "thread-2000" })
    expect(parseProfile(" drafts ")).toEqual({ name: "drafts" })
  })

  test("parses the parameterised missed-entries profile", () => {
    expect(parseProfile("missed-entries=200")).toEqual({ name: "missed-entries", entries: 200 })
  })

  test("an unknown profile fails loudly (INV-11)", () => {
    expect(() => parseProfile("thread-9000")).toThrow(UnknownPerfProfileError)
    expect(() => parseProfile("missed-entries")).toThrow(UnknownPerfProfileError)
    expect(() => parseProfile("missed-entries=0")).toThrow(UnknownPerfProfileError)
    expect(() => parseProfile("missed-entries=100001")).toThrow(UnknownPerfProfileError)
    expect(() => parseProfile("")).toThrow(UnknownPerfProfileError)
  })
})

describe("messagesForMissedEntries", () => {
  test("sizes a batch off the >=3-entries-per-message floor, never below one message", () => {
    expect([1, 10, 50, 199, 200].map(messagesForMissedEntries)).toEqual([1, 4, 17, 67, 67])
  })
})

describe("planSeed — each profile plans the documented operation counts", () => {
  test("large-stream: one channel and 5,000 messages", () => {
    expect(planSeed(parseProfile("large-stream"), empty)).toEqual([
      { kind: "createStream", key: "perf-large-stream", streamKind: "channel" },
      { kind: "postMessages", key: "perf-large-stream", from: 1, count: 5000 },
    ])
  })

  test("thread-500: an anchor message in a channel, then 500 replies in a thread under it", () => {
    expect(planSeed(parseProfile("thread-500"), empty)).toEqual([
      { kind: "createStream", key: "perf-thread-500", streamKind: "channel" },
      { kind: "postMessages", key: "perf-thread-500", from: 1, count: 1 },
      { kind: "createStream", key: "perf-thread-500-thread", streamKind: "thread", parentKey: "perf-thread-500" },
      { kind: "postMessages", key: "perf-thread-500-thread", from: 1, count: 500 },
    ])
  })

  test("thread-100 / thread-2000 differ only in reply count", () => {
    const replies = (profile: string) =>
      planSeed(parseProfile(profile), empty).filter((op) => op.kind === "postMessages" && op.key.endsWith("-thread"))
    expect(replies("thread-100")).toEqual([
      { kind: "postMessages", key: "perf-thread-100-thread", from: 1, count: 100 },
    ])
    expect(replies("thread-2000")).toEqual([
      { kind: "postMessages", key: "perf-thread-2000-thread", from: 1, count: 2000 },
    ])
  })

  test("missed-entries plans a head-delta advance carrying the run marker", () => {
    expect(planSeed(parseProfile("missed-entries=199"), empty, "run-a")).toEqual([
      { kind: "createStream", key: "perf-missed-entries", streamKind: "channel" },
      { kind: "advanceSyncLog", key: "perf-missed-entries", entries: 199, runMarker: "run-a" },
    ])
  })

  test("missed-entries without a run marker fails loudly (INV-11)", () => {
    expect(() => planSeed(parseProfile("missed-entries=10"), empty)).toThrow(/runMarker/)
  })

  test("drafts: one empty host channel per documented size, plus its draft", () => {
    expect(planSeed(parseProfile("drafts"), empty)).toEqual([
      ...DRAFT_PROFILE_SIZES.map((chars) => ({
        kind: "createStream" as const,
        key: `perf-draft-${chars}`,
        streamKind: "channel" as const,
      })),
      ...DRAFT_PROFILE_SIZES.map((chars) => ({ kind: "upsertDraft" as const, key: `perf-draft-${chars}`, chars })),
    ])
  })

  test("board-large: 24 channels — four full BOARD_SYNC_CONCURRENCY waves — each with 3 messages", () => {
    const plan = planSeed(parseProfile("board-large"), empty)
    expect(plan.filter((op) => op.kind === "createStream").map((op) => op.key)).toEqual(
      Array.from({ length: BOARD_LARGE_STREAM_COUNT }, (_, i) => `perf-board-${String(i + 1).padStart(2, "0")}`)
    )
    expect(plan.filter((op) => op.kind === "postMessages")).toEqual(
      Array.from({ length: BOARD_LARGE_STREAM_COUNT }, (_, i) => ({
        kind: "postMessages" as const,
        key: `perf-board-${String(i + 1).padStart(2, "0")}`,
        from: 1,
        count: BOARD_LARGE_MESSAGES_PER_STREAM,
      }))
    )
  })

  test("workspace-wide plans 60 channel creations on an empty workspace", () => {
    expect(WORKSPACE_WIDE_STREAM_COUNT).toBe(60)
    expect(WORKSPACE_WIDE_STREAM_COUNT).toBeGreaterThan(50)
    const plan = planSeed(parseProfile("workspace-wide"), empty)
    expect(plan.filter((op) => op.kind === "createStream").map((op) => op.key)).toEqual(
      Array.from({ length: WORKSPACE_WIDE_STREAM_COUNT }, (_, i) => wideKey(i))
    )
    expect(plan.filter((op) => op.kind === "postMessages")).toEqual(
      Array.from({ length: WORKSPACE_WIDE_STREAM_COUNT }, (_, i) => ({
        kind: "postMessages" as const,
        key: wideKey(i),
        from: 1,
        count: WORKSPACE_WIDE_MESSAGES_PER_STREAM,
      }))
    )
  })
})

describe("planSeed — a partially seeded workspace tops up rather than duplicating", () => {
  test("an existing stream is not recreated and only the shortfall is posted", () => {
    expect(planSeed(parseProfile("large-stream"), { messageCounts: { "perf-large-stream": 4990 } })).toEqual([
      { kind: "postMessages", key: "perf-large-stream", from: 4991, count: 10 },
    ])
  })

  test("a fully seeded profile plans nothing", () => {
    expect(
      planSeed(parseProfile("thread-100"), {
        messageCounts: { "perf-thread-100": 1, "perf-thread-100-thread": 100 },
      })
    ).toEqual([])
  })

  test("missed-entries reuses an existing channel and still opens a fresh gap on every run", () => {
    const existing = { messageCounts: { "perf-missed-entries": 9_000 } }
    expect(planSeed(parseProfile("missed-entries=10"), existing, "run-b")).toEqual([
      { kind: "advanceSyncLog", key: "perf-missed-entries", entries: 10, runMarker: "run-b" },
    ])
  })

  test("already-staged drafts are skipped, missing ones are staged", () => {
    expect(
      planSeed(parseProfile("drafts"), {
        messageCounts: Object.fromEntries(DRAFT_PROFILE_SIZES.map((chars) => [`perf-draft-${chars}`, 0])),
        draftKeys: ["perf-draft-1024", "perf-draft-10240"],
      })
    ).toEqual([
      { kind: "upsertDraft", key: "perf-draft-102400", chars: 102400 },
      { kind: "upsertDraft", key: "perf-draft-262144", chars: 262144 },
    ])
  })

  test("a half-seeded board tops up only the missing channels", () => {
    const plan = planSeed(parseProfile("board-large"), {
      messageCounts: { "perf-board-01": BOARD_LARGE_MESSAGES_PER_STREAM, "perf-board-02": 1 },
    })
    expect(plan.filter((op) => op.key === "perf-board-01")).toEqual([])
    expect(plan.filter((op) => op.key === "perf-board-02")).toEqual([
      { kind: "postMessages", key: "perf-board-02", from: 2, count: BOARD_LARGE_MESSAGES_PER_STREAM - 1 },
    ])
    const createdKeys = plan.filter((op) => op.kind === "createStream").map((op) => op.key)
    expect(createdKeys).toHaveLength(BOARD_LARGE_STREAM_COUNT - 2)
    expect(createdKeys).not.toContain("perf-board-01")
    expect(createdKeys).not.toContain("perf-board-02")
  })

  test("workspace-wide is idempotent when the channels already hold their message", () => {
    const messageCounts = Object.fromEntries(
      Array.from({ length: WORKSPACE_WIDE_STREAM_COUNT }, (_, i) => [wideKey(i), WORKSPACE_WIDE_MESSAGES_PER_STREAM])
    )
    expect(planSeed(parseProfile("workspace-wide"), { messageCounts })).toEqual([])
  })

  test("workspace-wide tops up a partially seeded workspace", () => {
    const plan = planSeed(parseProfile("workspace-wide"), {
      messageCounts: { [wideKey(0)]: WORKSPACE_WIDE_MESSAGES_PER_STREAM, [wideKey(1)]: 0 },
    })
    expect(plan.filter((op) => op.key === wideKey(0))).toEqual([])
    expect(plan.filter((op) => op.key === wideKey(1))).toEqual([
      { kind: "postMessages", key: wideKey(1), from: 1, count: WORKSPACE_WIDE_MESSAGES_PER_STREAM },
    ])
    const createdKeys = plan.filter((op) => op.kind === "createStream").map((op) => op.key)
    expect(createdKeys).toHaveLength(WORKSPACE_WIDE_STREAM_COUNT - 2)
    expect(createdKeys).not.toContain(wideKey(0))
    expect(createdKeys).not.toContain(wideKey(1))
  })
})

describe("seedSpec", () => {
  test("names the resolved profile, including the parameterised one", () => {
    expect(seedSpec(parseProfile("missed-entries=50")).profile).toBe("missed-entries=50")
    expect(seedSpec(parseProfile("board-large")).slots.length).toBe(BOARD_LARGE_STREAM_COUNT)
  })
})

describe("messageContent", () => {
  test("prefixes the slot key so a re-run recognises its own rows", () => {
    expect(messageContent("perf-large-stream", 7)).toBe("perf-large-stream #00007")
  })
})
