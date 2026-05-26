import { describe, it, expect } from "vitest"
import {
  friendlyTranscriptionError,
  shouldWarnNoAudio,
  noAudioWarningMessage,
  NO_AUDIO_WAIT_MS,
  NO_AUDIO_PEAK_THRESHOLD,
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

describe("shouldWarnNoAudio", () => {
  it("waits out the grace window before warning — a take just starting is never silent enough to flag", () => {
    expect(shouldWarnNoAudio(0, 0)).toBe(false)
    expect(shouldWarnNoAudio(NO_AUDIO_WAIT_MS - 1, 0)).toBe(false)
  })

  it("flags inputs that produced literal zero past the grace window", () => {
    expect(shouldWarnNoAudio(NO_AUDIO_WAIT_MS, 0)).toBe(true)
    expect(shouldWarnNoAudio(10_000, 0)).toBe(true)
  })

  it("does not flag inputs that crossed the ambient-noise floor — a working mic in a quiet room beats the threshold", () => {
    expect(shouldWarnNoAudio(NO_AUDIO_WAIT_MS, NO_AUDIO_PEAK_THRESHOLD)).toBe(false)
    expect(shouldWarnNoAudio(NO_AUDIO_WAIT_MS, NO_AUDIO_PEAK_THRESHOLD + 0.01)).toBe(false)
  })
})

describe("noAudioWarningMessage", () => {
  it("names the offending device when the browser revealed its label", () => {
    expect(noAudioWarningMessage("AirPods Pro")).toContain("AirPods Pro")
  })

  it("falls back to a generic phrase when the label is null or whitespace — labels are gated on permission and may be empty", () => {
    expect(noAudioWarningMessage(null)).toContain("your microphone")
    expect(noAudioWarningMessage("")).toContain("your microphone")
    expect(noAudioWarningMessage("   ")).toContain("your microphone")
  })
})
