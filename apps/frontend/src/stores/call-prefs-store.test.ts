import { describe, it, expect, beforeEach } from "vitest"
import {
  getCallPrefs,
  setCallLayout,
  setCallFilmstripSide,
  setCallSelfMirror,
  setCallSideDockWidth,
  resolveSelfMirror,
  __resetCallPrefsForTests,
} from "./call-prefs-store"

const STORAGE_KEY = "threa:callPrefs:v1"
const DEFAULTS = { layout: "speaker", filmstripSide: "bottom", selfMirror: "auto", sideDockWidth: null }

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
    setCallFilmstripSide("side")

    expect(getCallPrefs()).toEqual({ layout: "grid", filmstripSide: "side", selfMirror: "auto", sideDockWidth: null })

    // Re-read from storage (not a hand-crafted fixture) — proves the write round-trips.
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({ layout: "grid", filmstripSide: "side", selfMirror: "auto", sideDockWidth: null })
  })

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual(DEFAULTS)
  })

  it("falls back per-field on an out-of-range persisted value", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout: "diagonal", filmstripSide: "side" }))
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({
      layout: "speaker",
      filmstripSide: "side",
      selfMirror: "auto",
      sideDockWidth: null,
    })
  })

  it("persists an explicit selfMirror override", () => {
    setCallSelfMirror("off")
    __resetCallPrefsForTests()
    expect(getCallPrefs().selfMirror).toBe("off")
  })

  it("round-trips a sideDockWidth through the store", () => {
    setCallSideDockWidth(480)
    expect(getCallPrefs().sideDockWidth).toBe(480)
    __resetCallPrefsForTests()
    expect(getCallPrefs().sideDockWidth).toBe(480)
  })

  it("falls back to null on an invalid persisted sideDockWidth", () => {
    for (const bad of ["wide", -5, 0]) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sideDockWidth: bad }))
      __resetCallPrefsForTests()
      expect(getCallPrefs().sideDockWidth).toBeNull()
    }
  })
})

describe("resolveSelfMirror", () => {
  it("auto mirrors desktop (any camera) and mobile front, not mobile back", () => {
    expect(resolveSelfMirror("auto", { isMobile: false, facingMode: null })).toBe(true)
    expect(resolveSelfMirror("auto", { isMobile: false, facingMode: "environment" })).toBe(true)
    expect(resolveSelfMirror("auto", { isMobile: true, facingMode: "user" })).toBe(true)
    expect(resolveSelfMirror("auto", { isMobile: true, facingMode: null })).toBe(true)
    expect(resolveSelfMirror("auto", { isMobile: true, facingMode: "environment" })).toBe(false)
  })

  it("explicit on/off overrides the facing default", () => {
    expect(resolveSelfMirror("on", { isMobile: true, facingMode: "environment" })).toBe(true)
    expect(resolveSelfMirror("off", { isMobile: false, facingMode: null })).toBe(false)
  })
})
