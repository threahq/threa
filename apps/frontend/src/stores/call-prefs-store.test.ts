import { describe, it, expect, beforeEach } from "vitest"
import {
  getCallPrefs,
  setCallLayout,
  setCallDockPosition,
  setCallFilmstripSide,
  __resetCallPrefsForTests,
} from "./call-prefs-store"

const STORAGE_KEY = "threa:callPrefs:v1"
const DEFAULTS = { layout: "speaker", dockPosition: "side", filmstripSide: "bottom" }

beforeEach(() => {
  localStorage.clear()
  __resetCallPrefsForTests()
})

describe("call-prefs-store", () => {
  it("defaults when storage is empty", () => {
    expect(getCallPrefs()).toEqual(DEFAULTS)
  })

  it("a set persists to localStorage and reads back through the store", () => {
    setCallLayout("grid")
    setCallDockPosition("top")
    setCallFilmstripSide("side")

    expect(getCallPrefs()).toEqual({ layout: "grid", dockPosition: "top", filmstripSide: "side" })

    // Re-read from storage (not a hand-crafted fixture) — proves the write round-trips.
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({ layout: "grid", dockPosition: "top", filmstripSide: "side" })
  })

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual(DEFAULTS)
  })

  it("falls back per-field on an out-of-range persisted value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout: "grid", dockPosition: "diagonal" }))
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({ layout: "grid", dockPosition: "side", filmstripSide: "bottom" })
  })
})
