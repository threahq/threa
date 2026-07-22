import { describe, it, expect, beforeEach } from "vitest"
import {
  getCallPrefs,
  setCallLayout,
  setCallFilmstripSide,
  setCallSelfMirror,
  setCallSideDockWidth,
  setDesktopCallSurface,
  setLastDesktopSurface,
  resolveSelfMirror,
  resolveDesktopSurface,
  __resetCallPrefsForTests,
} from "./call-prefs-store"

const STORAGE_KEY = "threa:callPrefs:v1"
const DEFAULTS = {
  layout: "speaker",
  filmstripSide: "bottom",
  selfMirror: "auto",
  sideDockWidth: null,
  desktopCallSurface: "keep_last",
  lastDesktopSurface: "floating",
}

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

    expect(getCallPrefs()).toEqual({ ...DEFAULTS, layout: "grid", filmstripSide: "side" })

    // Re-read from storage (not a hand-crafted fixture) — proves the write round-trips.
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({ ...DEFAULTS, layout: "grid", filmstripSide: "side" })
  })

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual(DEFAULTS)
  })

  it("falls back per-field on an out-of-range persisted value", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        layout: "diagonal",
        filmstripSide: "side",
        desktopCallSurface: "corner",
        lastDesktopSurface: "x",
      })
    )
    __resetCallPrefsForTests()
    expect(getCallPrefs()).toEqual({ ...DEFAULTS, filmstripSide: "side" })
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

  it("defaults the desktop surface to keep_last with a floating last", () => {
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    expect(getCallPrefs().lastDesktopSurface).toBe("floating")
  })

  it("round-trips desktopCallSurface and lastDesktopSurface through the store", () => {
    setDesktopCallSurface("sidebar")
    setLastDesktopSurface("sidebar")
    expect(getCallPrefs().desktopCallSurface).toBe("sidebar")
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
    __resetCallPrefsForTests()
    expect(getCallPrefs().desktopCallSurface).toBe("sidebar")
    expect(getCallPrefs().lastDesktopSurface).toBe("sidebar")
  })

  it("falls back to defaults on an invalid persisted desktop surface", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ desktopCallSurface: "diagonal", lastDesktopSurface: "keep_last" })
    )
    __resetCallPrefsForTests()
    expect(getCallPrefs().desktopCallSurface).toBe("keep_last")
    expect(getCallPrefs().lastDesktopSurface).toBe("floating")
  })
})

describe("resolveDesktopSurface", () => {
  it("an override wins over the pref and last", () => {
    expect(resolveDesktopSurface("sidebar", "sidebar", "floating")).toBe("floating")
    expect(resolveDesktopSurface("floating", "floating", "sidebar")).toBe("sidebar")
    expect(resolveDesktopSurface("keep_last", "sidebar", "floating")).toBe("floating")
  })

  it("keep_last follows the last-used surface when there is no override", () => {
    expect(resolveDesktopSurface("keep_last", "floating", null)).toBe("floating")
    expect(resolveDesktopSurface("keep_last", "sidebar", null)).toBe("sidebar")
  })

  it("an explicit pin returns as-is regardless of last", () => {
    expect(resolveDesktopSurface("sidebar", "floating", null)).toBe("sidebar")
    expect(resolveDesktopSurface("floating", "sidebar", null)).toBe("floating")
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
