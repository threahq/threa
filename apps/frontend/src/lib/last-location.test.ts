import { describe, it, expect, beforeEach } from "vitest"
import {
  sanitizeBoardSearch,
  buildBoardHref,
  getLastLocation,
  setLastLocation,
  clearLastLocation,
  type LastLocation,
} from "./last-location"

const USER = "usr_1"
const WS = "ws_1"
const key = `threa-last-location:${USER}:${WS}`
const legacyKey = `threa-last-stream:${USER}:${WS}`

beforeEach(() => localStorage.clear())

describe("sanitizeBoardSearch", () => {
  it("keeps the lens, the board filter axes, and archived", () => {
    // Comma-separated id lists round-trip through URLSearchParams (which
    // percent-encodes the comma, matching savedViewHref's own output), so
    // compare by parsed params rather than raw string.
    const search =
      "?lens=active&in=stream_a,stream_b&not-in=stream_c&is=dm&not-is=channel&label=lbl_1&not-label=lbl_2&archived=true"
    const out = new URLSearchParams(sanitizeBoardSearch(search))
    expect(Object.fromEntries(out)).toEqual({
      lens: "active",
      in: "stream_a,stream_b",
      "not-in": "stream_c",
      is: "dm",
      "not-is": "channel",
      label: "lbl_1",
      "not-label": "lbl_2",
      archived: "true",
    })
  })

  it("degrades an unknown lens value to the default", () => {
    expect(sanitizeBoardSearch("?lens=bogus&in=stream_a")).toBe("?lens=all&in=stream_a")
  })

  it("strips panel, m, and unrelated params", () => {
    expect(sanitizeBoardSearch("?in=stream_a&panel=stream_z&m=evt_1&q=hi")).toBe("?in=stream_a")
  })

  it("returns an empty string when nothing survives", () => {
    expect(sanitizeBoardSearch("?panel=stream_z&m=evt_1")).toBe("")
    expect(sanitizeBoardSearch("")).toBe("")
  })
})

describe("buildBoardHref", () => {
  it("carries the lens in the query", () => {
    expect(buildBoardHref(WS, { search: "?lens=active" }, [])).toBe("/w/ws_1/board?lens=active")
  })

  it("restores the bare entry alias for a record captured there", () => {
    expect(buildBoardHref(WS, { search: "" }, [])).toBe("/w/ws_1/board")
  })

  it("sweeps stale ids out of the in axis against known streams", () => {
    const href = buildBoardHref(WS, { search: "?lens=all&in=stream_a,stream_gone&is=dm" }, ["stream_a", "stream_b"])
    expect(href).toBe("/w/ws_1/board?lens=all&in=stream_a&is=dm")
  })

  it("preserves an unknown not-in id (thread anchors are lazily hydrated)", () => {
    const href = buildBoardHref(WS, { search: "?lens=all&in=stream_a&not-in=stream_thread_gone&is=dm" }, ["stream_a"])
    expect(href).toBe("/w/ws_1/board?lens=all&in=stream_a&not-in=stream_thread_gone&is=dm")
  })

  it("drops a scope param that becomes empty after the sweep", () => {
    const href = buildBoardHref(WS, { search: "?lens=all&in=stream_gone&label=lbl_1" }, ["stream_a"])
    expect(href).toBe("/w/ws_1/board?lens=all&label=lbl_1")
  })

  it("skips the sweep when no known ids are available", () => {
    const href = buildBoardHref(WS, { search: "?lens=all&in=stream_gone" }, [])
    expect(href).toBe("/w/ws_1/board?lens=all&in=stream_gone")
  })

  it("sanitizes the search before building the href", () => {
    const href = buildBoardHref(WS, { search: "?lens=all&in=stream_a&panel=stream_z" }, ["stream_a"])
    expect(href).toBe("/w/ws_1/board?lens=all&in=stream_a")
  })
})

describe("getLastLocation / setLastLocation round-trip", () => {
  it("round-trips a stream record", () => {
    const record: LastLocation = { surface: "stream", streamId: "stream_a", board: null }
    setLastLocation(USER, WS, record)
    expect(getLastLocation(USER, WS)).toEqual(record)
  })

  it("round-trips a board record and sanitizes its search on write", () => {
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { search: "?lens=active&in=stream_a&panel=stream_z" },
    })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "board",
      streamId: "stream_a",
      board: { search: "?lens=active&in=stream_a" },
    })
  })

  it("returns null when no record exists", () => {
    expect(getLastLocation(USER, WS)).toBeNull()
  })

  it("returns null and does not throw on a malformed record", () => {
    localStorage.setItem(key, "{not json")
    expect(getLastLocation(USER, WS)).toBeNull()
  })
})

describe("legacy migration", () => {
  it("falls back to the legacy stream key as a stream surface", () => {
    localStorage.setItem(legacyKey, "stream_legacy")
    expect(getLastLocation(USER, WS)).toEqual({ surface: "stream", streamId: "stream_legacy", board: null })
  })

  it("prefers a new-format record over the legacy key", () => {
    localStorage.setItem(legacyKey, "stream_legacy")
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_new", board: null })
    expect(getLastLocation(USER, WS)?.streamId).toBe("stream_new")
  })

  it("deletes the legacy key when a new record is written", () => {
    localStorage.setItem(legacyKey, "stream_legacy")
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_new", board: null })
    expect(localStorage.getItem(legacyKey)).toBeNull()
  })
})

describe("clearLastLocation", () => {
  it("removes both the new and the legacy keys", () => {
    localStorage.setItem(legacyKey, "stream_legacy")
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_a", board: null })
    localStorage.setItem(legacyKey, "stream_legacy")
    clearLastLocation(USER, WS)
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(legacyKey)).toBeNull()
    expect(getLastLocation(USER, WS)).toBeNull()
  })
})
