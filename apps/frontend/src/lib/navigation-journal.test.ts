import { beforeEach, describe, expect, it } from "vitest"
import {
  EMPTY_JOURNAL,
  NAVIGATION_JOURNAL_LIMIT,
  journalPath,
  journalStreamIds,
  journalTarget,
  isJournaledPath,
  readJournal,
  recentStreams,
  recordVisit,
  resetJournalCacheForTests,
  subscribeJournal,
  writeJournal,
  type NavigationJournal,
} from "./navigation-journal"

const USER = "usr_1"
const WS = "ws_1"
const key = `threa-navigation-journal:${USER}:${WS}`

beforeEach(() => {
  localStorage.clear()
  resetJournalCacheForTests()
})

function journalOf(paths: string[], cursor = paths.length - 1): NavigationJournal {
  return { entries: paths.map((path, i) => ({ path, at: i + 1 })), cursor }
}

describe("journalPath", () => {
  it("keeps the allowlisted params in URL order and strips the rest", () => {
    expect(
      journalPath({
        pathname: `/w/${WS}/s/stream_a`,
        search: "?m=evt_1&panel=stream_b&memo=memo_1&trace=trc_1&convView=split&media=1",
      })
    ).toBe(`/w/${WS}/s/stream_a?panel=stream_b&trace=trc_1&convView=split`)
  })

  it("keeps the board vocabulary", () => {
    expect(journalPath({ pathname: `/w/${WS}/board`, search: "?lens=mine&in=stream_a&settings=1" })).toBe(
      `/w/${WS}/board?lens=mine&in=stream_a`
    )
  })

  it("returns the pathname alone when no param survives", () => {
    expect(journalPath({ pathname: `/w/${WS}/s/stream_a`, search: "?m=evt_1" })).toBe(`/w/${WS}/s/stream_a`)
  })
})

describe("isJournaledPath", () => {
  it("journals pages under the workspace but not the index, delegations or memos", () => {
    expect({
      index: isJournaledPath(`/w/${WS}`, WS),
      stream: isJournaledPath(`/w/${WS}/s/stream_a`, WS),
      delegation: isJournaledPath(`/w/${WS}/delegations/dlg_1`, WS),
      memo: isJournaledPath(`/w/${WS}/memos/memo_1`, WS),
      other: isJournaledPath("/settings", WS),
    }).toEqual({ index: false, stream: true, delegation: false, memo: false, other: false })
  })
})

describe("journalStreamIds", () => {
  it("returns the page stream and every panel stream", () => {
    expect(journalStreamIds(`/w/${WS}/s/stream_a?panel=stream_b&panel=stream_c`, WS)).toEqual([
      "stream_a",
      "stream_b",
      "stream_c",
    ])
  })

  it("returns only panels on a non-stream page", () => {
    expect(journalStreamIds(`/w/${WS}/board?panel=stream_b`, WS)).toEqual(["stream_b"])
  })
})

describe("recordVisit", () => {
  it("case 1: a matching cursor hint moves the cursor and stamps the entry", () => {
    const journal = journalOf(["/a", "/b", "/c"])
    expect(recordVisit(journal, "/a", 99, { cursorHint: 0, navigationType: "PUSH" })).toEqual({
      entries: [
        { path: "/a", at: 99 },
        { path: "/b", at: 2 },
        { path: "/c", at: 3 },
      ],
      cursor: 0,
    })
  })

  it("case 2: the same path as the entry at the cursor is not a new entry", () => {
    const journal = journalOf(["/a", "/b"])
    expect(recordVisit(journal, "/b", 99, { navigationType: "PUSH" })).toBe(journal)
  })

  it("case 3: a POP onto the neighbour walks the cursor", () => {
    const journal = journalOf(["/a", "/b", "/c"], 1)
    expect(recordVisit(journal, "/a", 99, { navigationType: "POP" })).toEqual({
      entries: [
        { path: "/a", at: 99 },
        { path: "/b", at: 2 },
        { path: "/c", at: 3 },
      ],
      cursor: 0,
    })
    expect(recordVisit(journal, "/c", 99, { navigationType: "POP" }).cursor).toBe(2)
  })

  it("case 3 is POP-only: a PUSH onto the neighbour is a fresh entry", () => {
    const journal = journalOf(["/a", "/b", "/c"], 1)
    expect(recordVisit(journal, "/a", 99, { navigationType: "PUSH" })).toEqual({
      entries: [
        { path: "/a", at: 1 },
        { path: "/b", at: 2 },
        { path: "/a", at: 99 },
      ],
      cursor: 2,
    })
  })

  it("case 4: a fresh visit drops everything after the cursor", () => {
    const journal = journalOf(["/a", "/b", "/c"], 0)
    expect(recordVisit(journal, "/d", 99, { navigationType: "PUSH" })).toEqual({
      entries: [
        { path: "/a", at: 1 },
        { path: "/d", at: 99 },
      ],
      cursor: 1,
    })
  })

  it("never mutates the journal it was given", () => {
    const journal = journalOf(["/a", "/b"])
    const before = structuredClone(journal)
    recordVisit(journal, "/c", 99, { navigationType: "PUSH" })
    recordVisit(journal, "/a", 99, { cursorHint: 0, navigationType: "PUSH" })
    expect(journal).toEqual(before)
  })

  it("trims the oldest entries beyond the bound and keeps the cursor at the tail", () => {
    let journal = EMPTY_JOURNAL
    for (let i = 0; i < NAVIGATION_JOURNAL_LIMIT + 3; i++) {
      journal = recordVisit(journal, `/p${i}`, i, { navigationType: "PUSH" })
    }
    expect({
      length: journal.entries.length,
      first: journal.entries[0].path,
      cursor: journal.cursor,
      last: journal.entries[journal.cursor].path,
    }).toEqual({
      length: NAVIGATION_JOURNAL_LIMIT,
      first: "/p3",
      cursor: NAVIGATION_JOURNAL_LIMIT - 1,
      last: `/p${NAVIGATION_JOURNAL_LIMIT + 2}`,
    })
  })
})

describe("journalTarget", () => {
  it("resolves the neighbouring entries and returns null at the ends", () => {
    const journal = journalOf(["/a", "/b"], 1)
    expect({ back: journalTarget(journal, -1), forward: journalTarget(journal, 1) }).toEqual({
      back: { to: "/a", state: { journalCursor: 0 } },
      forward: null,
    })
    expect(journalTarget(EMPTY_JOURNAL, -1)).toBeNull()
  })
})

describe("recentStreams", () => {
  it("lists distinct stream pages newest first, excluding the one at the cursor", () => {
    const journal = journalOf([
      `/w/${WS}/s/stream_a`,
      `/w/${WS}/board?lens=mine`,
      `/w/${WS}/s/stream_b`,
      `/w/${WS}/s/stream_a?panel=stream_c`,
      `/w/${WS}/s/stream_c`,
    ])
    expect(recentStreams(journal, WS)).toEqual([
      { streamId: "stream_a", href: `/w/${WS}/s/stream_a`, at: 4 },
      { streamId: "stream_b", href: `/w/${WS}/s/stream_b`, at: 3 },
    ])
  })

  it("honours the limit", () => {
    const journal = journalOf([`/w/${WS}/s/s1`, `/w/${WS}/s/s2`, `/w/${WS}/s/s3`], 2)
    expect(recentStreams(journal, WS, 1)).toEqual([{ streamId: "s2", href: `/w/${WS}/s/s2`, at: 2 }])
  })
})

describe("storage", () => {
  it("round-trips a journal and returns a referentially stable snapshot", () => {
    const journal = journalOf([`/w/${WS}/s/stream_a`])
    writeJournal(USER, WS, journal)
    resetJournalCacheForTests()
    const first = readJournal(USER, WS)
    expect(first).toEqual(journal)
    expect(readJournal(USER, WS)).toBe(first)
  })

  it("returns the empty journal for malformed or absent records", () => {
    expect(readJournal(USER, WS)).toBe(EMPTY_JOURNAL)
    for (const raw of [
      "{",
      "null",
      '{"entries":"nope","cursor":0}',
      '{"entries":[{"path":1,"at":1}],"cursor":0}',
      '{"entries":[],"cursor":4}',
    ]) {
      localStorage.setItem(key, raw)
      resetJournalCacheForTests()
      expect(readJournal(USER, WS)).toBe(EMPTY_JOURNAL)
    }
  })

  it("notifies subscribers of the key on write, and stops after unsubscribe", () => {
    const seen: number[] = []
    const unsubscribe = subscribeJournal(USER, WS, () => seen.push(readJournal(USER, WS).entries.length))
    writeJournal(USER, WS, journalOf(["/a"]))
    writeJournal("usr_other", WS, journalOf(["/a", "/b"]))
    unsubscribe()
    writeJournal(USER, WS, journalOf(["/a", "/b", "/c"]))
    expect(seen).toEqual([1])
  })
})
