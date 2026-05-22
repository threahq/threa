import { describe, it, expect } from "vitest"
import { friendlyTranscriptionError } from "./use-voice-dictation"

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
