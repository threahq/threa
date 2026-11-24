import { describe, it, expect, beforeEach } from "vitest"
import { DEFAULT_MEDIA_PREFERENCES, clampPlaybackRate, loadMediaPreferences, saveMediaPreferences } from "./preferences"

const KEY = "threa:media-player:preferences"

beforeEach(() => {
  localStorage.removeItem(KEY)
})

describe("media preferences", () => {
  it("defaults when nothing is stored or the record is corrupt", () => {
    expect(loadMediaPreferences()).toEqual(DEFAULT_MEDIA_PREFERENCES)
    localStorage.setItem(KEY, "{not json")
    expect(loadMediaPreferences()).toEqual(DEFAULT_MEDIA_PREFERENCES)
  })

  it("round-trips rate, volume and mute", () => {
    saveMediaPreferences({ playbackRate: 1.5, volume: 0.4, muted: true })
    expect(loadMediaPreferences()).toEqual({ playbackRate: 1.5, volume: 0.4, muted: true })
  })

  it("clamps the rate to the offered set and the volume to 0..1", () => {
    localStorage.setItem(KEY, JSON.stringify({ playbackRate: 3, volume: 7, muted: "yes" }))
    expect(loadMediaPreferences()).toEqual({ playbackRate: 2, volume: 1, muted: false })
    expect([clampPlaybackRate(0.1), clampPlaybackRate(1.3), clampPlaybackRate(Number.NaN)]).toEqual([0.5, 1.25, 1])
  })
})
