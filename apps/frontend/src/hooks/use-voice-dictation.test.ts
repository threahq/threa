import { describe, it, expect } from "vitest"
import {
  friendlyTranscriptionError,
  shouldWarnNoAudio,
  noAudioWarningMessage,
  NO_AUDIO_INITIAL_WAIT_MS,
  NO_AUDIO_SILENCE_WAIT_MS,
} from "./use-voice-dictation"

describe("friendlyTranscriptionError", () => {
  it("phrases known upstream codes as short human copy", () => {
    expect(friendlyTranscriptionError("UPSTREAM_CLOSED")).toBe("Dictation stopped unexpectedly")
    expect(friendlyTranscriptionError("INPUT_ERROR")).toBe("Couldn't make out the audio")
  })

  it("never echoes a raw provider string — unknown/leaky codes fall back to generic copy", () => {
    expect(friendlyTranscriptionError(undefined)).toBe("Dictation hit a problem")
    // Even if a raw provider message arrives in `code`, we don't surface it.
    expect(friendlyTranscriptionError("ElevenLabs realtime closed (code 1000)")).toBe("Dictation hit a problem")
  })
})

describe("shouldWarnNoAudio — initial silence branch (peak still below floor)", () => {
  it("waits out the grace window — a take just starting is never silent enough to flag", () => {
    expect(shouldWarnNoAudio({ elapsedMs: 0, silenceMs: 0, peakLevel: 0 })).toBe(false)
    expect(
      shouldWarnNoAudio({
        elapsedMs: NO_AUDIO_INITIAL_WAIT_MS - 1,
        silenceMs: NO_AUDIO_INITIAL_WAIT_MS - 1,
        peakLevel: 0,
      })
    ).toBe(false)
  })

  it("flags inputs that produced literal zero past the grace window", () => {
    expect(
      shouldWarnNoAudio({ elapsedMs: NO_AUDIO_INITIAL_WAIT_MS, silenceMs: NO_AUDIO_INITIAL_WAIT_MS, peakLevel: 0 })
    ).toBe(true)
    expect(shouldWarnNoAudio({ elapsedMs: 10_000, silenceMs: 10_000, peakLevel: 0 })).toBe(true)
  })
})

describe("shouldWarnNoAudio — lost-signal branch (peak above floor, was working)", () => {
  it("does not flag short pauses — a user pausing mid-sentence shouldn't get nagged", () => {
    expect(shouldWarnNoAudio({ elapsedMs: 8_000, silenceMs: 1_000, peakLevel: 0.3 })).toBe(false)
    expect(shouldWarnNoAudio({ elapsedMs: 8_000, silenceMs: NO_AUDIO_SILENCE_WAIT_MS - 1, peakLevel: 0.3 })).toBe(false)
  })

  it("flags inputs that produced audio briefly and then went dead — the actual headphone-dropout case", () => {
    // The reported bug: a single "yes" came through (peak crossed threshold),
    // then headphones dropped HFP and the analyser went back to zeros. The
    // initial-silence check above already passed, so we need the silence-since-last-signal
    // check to catch the drop.
    expect(shouldWarnNoAudio({ elapsedMs: 10_000, silenceMs: NO_AUDIO_SILENCE_WAIT_MS, peakLevel: 0.4 })).toBe(true)
    expect(shouldWarnNoAudio({ elapsedMs: 12_000, silenceMs: 7_000, peakLevel: 0.4 })).toBe(true)
  })

  it("uses the silence window even early in the take — peak above floor switches to the lost-signal threshold immediately", () => {
    // elapsed is small, but peak is high → we're in the lost-signal branch.
    // Silence below 5s doesn't fire; at or above does.
    expect(shouldWarnNoAudio({ elapsedMs: 3_000, silenceMs: 2_500, peakLevel: 0.4 })).toBe(false)
    expect(shouldWarnNoAudio({ elapsedMs: 6_500, silenceMs: NO_AUDIO_SILENCE_WAIT_MS, peakLevel: 0.4 })).toBe(true)
  })
})

describe("noAudioWarningMessage", () => {
  it("names the offending device when the browser revealed its label", () => {
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: false })).toContain("AirPods Pro")
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: true })).toContain("AirPods Pro")
  })

  it("falls back to a generic phrase when the label is null or whitespace — labels are gated on permission and may be empty", () => {
    expect(noAudioWarningMessage({ deviceLabel: null, everHadSignal: false })).toContain("your microphone")
    expect(noAudioWarningMessage({ deviceLabel: "", everHadSignal: false })).toContain("your microphone")
    expect(noAudioWarningMessage({ deviceLabel: "   ", everHadSignal: false })).toContain("your microphone")
  })

  it("uses different phrasing for never-had-signal vs lost-signal — the remedy is different", () => {
    // Initial silence → try a different input device (the current one is dead).
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: false })).toMatch(/not hearing/i)
    // Lost signal → check the current input or switch (it WAS working).
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: true })).toMatch(/dropped/i)
  })
})
