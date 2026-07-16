import { describe, expect, it } from "vitest"
import { StreamTypes } from "@threa/types"
import type { Stream } from "@threa/types"
import type { UrgencyLevel } from "@/components/layout/sidebar/types"
import {
  compareStreamEntries,
  scoreStreamMatch,
  type SortableEntry,
  type SortableStream,
  type StreamSortMode,
} from "./stream-sort"

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: overrides.id ?? "stream_x",
    workspaceId: "ws_1",
    type: overrides.type ?? StreamTypes.CHANNEL,
    displayName: overrides.displayName ?? null,
    slug: overrides.slug ?? null,
    description: null,
    visibility: "public",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_a",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  }
}

function makeSortable(overrides: Partial<Stream> & { lastMessageAt?: string } = {}): SortableStream {
  const stream = makeStream(overrides)
  return {
    ...stream,
    lastMessagePreview: overrides.lastMessageAt ? { createdAt: overrides.lastMessageAt } : null,
  }
}

function makeEntry<S extends SortableStream>(
  stream: S,
  overrides: { score?: number; urgency?: UrgencyLevel } = {}
): SortableEntry<S> {
  return { stream, score: overrides.score ?? 0, urgency: overrides.urgency ?? "quiet" }
}

function sort<S extends SortableStream>(
  entries: SortableEntry<S>[],
  options: { isSearching: boolean; mode: StreamSortMode }
): string[] {
  return [...entries].sort((a, b) => compareStreamEntries(a, b, options)).map((e) => e.stream.id)
}

describe("scoreStreamMatch", () => {
  it("returns 0 for empty query (no scoring required)", () => {
    expect(scoreStreamMatch(makeStream({ slug: "general" }), "")).toBe(0)
  })

  it("ranks exact match best, then prefix, then substring, then fuzzy, then id-fallback", () => {
    const general = makeStream({ id: "stream_a", slug: "general" })
    const generic = makeStream({ id: "stream_b", slug: "generic" })
    const ageneral = makeStream({ id: "stream_c", slug: "ageneral" })
    const fuzzy = makeStream({ id: "stream_d", slug: "growth-plan" })
    const idMatch = makeStream({ id: "stream_general_id", slug: "elsewhere" })

    const scores = [
      scoreStreamMatch(general, "#general"),
      scoreStreamMatch(generic, "#gen"),
      scoreStreamMatch(ageneral, "general"),
      scoreStreamMatch(fuzzy, "grpl"),
      scoreStreamMatch(idMatch, "general"),
    ]
    expect(scores[0]).toBe(0)
    expect(scores.every((s) => s !== Infinity)).toBe(true)
    expect([...scores]).toEqual([...scores].sort((a, b) => a - b))
  })

  it("matches across separator differences", () => {
    const stream = makeStream({ slug: "growth-plan" })
    expect(scoreStreamMatch(stream, "growth plan")).not.toBe(Infinity)
    expect(scoreStreamMatch(stream, "growthplan")).not.toBe(Infinity)
  })

  it("returns Infinity when no part of the stream matches", () => {
    expect(scoreStreamMatch(makeStream({ slug: "general" }), "zzz")).toBe(Infinity)
  })
})

describe("compareStreamEntries — searching", () => {
  it("orders by score then alphabetical (mode is ignored)", () => {
    const entries = [
      makeEntry(makeSortable({ id: "s_b", slug: "beta" }), { score: 2 }),
      makeEntry(makeSortable({ id: "s_a", slug: "alpha" }), { score: 1 }),
      makeEntry(makeSortable({ id: "s_c", slug: "charlie" }), { score: 1 }),
    ]
    expect(sort(entries, { isSearching: true, mode: "recency" })).toEqual(["s_a", "s_c", "s_b"])
    // The toggle is ignored when searching: same order.
    expect(sort(entries, { isSearching: true, mode: "alphabetical" })).toEqual(["s_a", "s_c", "s_b"])
  })
})

describe("compareStreamEntries — browsing in recency mode", () => {
  it("prioritizes urgency before recency", () => {
    const old = makeSortable({
      id: "s_old_mention",
      slug: "old",
      lastMessageAt: "2025-01-01T00:00:00.000Z",
    })
    const recent = makeSortable({
      id: "s_recent_quiet",
      slug: "recent",
      lastMessageAt: "2026-04-29T00:00:00.000Z",
    })

    const result = sort([makeEntry(recent, { urgency: "quiet" }), makeEntry(old, { urgency: "mentions" })], {
      isSearching: false,
      mode: "recency",
    })
    expect(result).toEqual(["s_old_mention", "s_recent_quiet"])
  })

  it("falls through to activity time when urgency ties", () => {
    const olderQuiet = makeSortable({
      id: "s_older",
      slug: "older",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
    })
    const newerQuiet = makeSortable({
      id: "s_newer",
      slug: "newer",
      lastMessageAt: "2026-04-29T00:00:00.000Z",
    })

    const result = sort([makeEntry(olderQuiet, { urgency: "quiet" }), makeEntry(newerQuiet, { urgency: "quiet" })], {
      isSearching: false,
      mode: "recency",
    })
    expect(result).toEqual(["s_newer", "s_older"])
  })

  it("falls back to alphabetical when urgency and activity time tie", () => {
    const sameTime = "2026-04-01T00:00:00.000Z"
    const beta = makeSortable({ id: "s_beta", slug: "beta", lastMessageAt: sameTime })
    const alpha = makeSortable({ id: "s_alpha", slug: "alpha", lastMessageAt: sameTime })

    const result = sort([makeEntry(beta), makeEntry(alpha)], { isSearching: false, mode: "recency" })
    expect(result).toEqual(["s_alpha", "s_beta"])
  })

  it("uses createdAt when lastMessagePreview is missing", () => {
    const older = makeSortable({ id: "s_older", slug: "older", createdAt: "2025-01-01T00:00:00.000Z" })
    const newer = makeSortable({ id: "s_newer", slug: "newer", createdAt: "2026-03-01T00:00:00.000Z" })

    const result = sort([makeEntry(older), makeEntry(newer)], { isSearching: false, mode: "recency" })
    expect(result).toEqual(["s_newer", "s_older"])
  })
})

describe("compareStreamEntries — browsing in alphabetical mode", () => {
  it("ignores urgency and recency", () => {
    const recentMention = makeSortable({
      id: "s_zoo",
      slug: "zoo",
      lastMessageAt: "2026-04-29T00:00:00.000Z",
    })
    const oldQuiet = makeSortable({
      id: "s_aaa",
      slug: "aaa",
      lastMessageAt: "2025-01-01T00:00:00.000Z",
    })

    const result = sort(
      [makeEntry(recentMention, { urgency: "mentions" }), makeEntry(oldQuiet, { urgency: "quiet" })],
      { isSearching: false, mode: "alphabetical" }
    )
    expect(result).toEqual(["s_aaa", "s_zoo"])
  })
})
