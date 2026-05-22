import { describe, expect, test } from "bun:test"
import type { ModelRegistry } from "../../../lib/ai/model-registry"
import { createTranscription } from "./strategy"

function fakeRegistry(audioModels: Set<string>): ModelRegistry {
  return {
    supportsAudioInput: (modelId: string) => audioModels.has(modelId),
  } as unknown as ModelRegistry
}

describe("createTranscription", () => {
  test("rejects a model the registry says has no audio input", async () => {
    const transcription = createTranscription({
      elevenlabs: { apiKey: "key" },
      modelRegistry: fakeRegistry(new Set()),
    })
    await expect(transcription.open({ model: "elevenlabs:scribe-v2-realtime" })).rejects.toThrow(
      /does not support audio input/
    )
  })

  test("rejects a provider with no registered strategy", async () => {
    const transcription = createTranscription({
      elevenlabs: { apiKey: "key" },
      modelRegistry: fakeRegistry(new Set(["deepgram:nova-3"])),
    })
    await expect(transcription.open({ model: "deepgram:nova-3" })).rejects.toThrow(/No transcription strategy/)
  })

  test("rejects elevenlabs when no key is configured (provider disabled)", async () => {
    const transcription = createTranscription({
      modelRegistry: fakeRegistry(new Set(["elevenlabs:scribe-v2-realtime"])),
    })
    await expect(transcription.open({ model: "elevenlabs:scribe-v2-realtime" })).rejects.toThrow(
      /No transcription strategy/
    )
  })
})
