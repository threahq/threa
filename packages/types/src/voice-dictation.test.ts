import { describe, expect, test } from "bun:test"
import type { VoiceTranscriptPolished } from "./voice-dictation"

describe("voice dictation protocol types", () => {
  test("canonical polished event narrows to v4 replacement fields", () => {
    const sourceIds = (event: VoiceTranscriptPolished): string[] => {
      if ("protocolVersion" in event) return event.sources.map((source) => source.chunkId)
      return [event.chunkId]
    }

    const event: VoiceTranscriptPolished = {
      protocolVersion: 4,
      operationId: "op_1",
      voiceSessionId: "voice_1",
      authoritative: true,
      resultChunkId: "chunk_result",
      throughRevision: 2,
      sources: [{ chunkId: "chunk_1", throughRevision: 2 }],
      raw: "raw",
      polished: "Polished.",
      rawContentJson: { type: "doc" },
      polishedContentJson: { type: "doc" },
    }
    expect(sourceIds(event)).toEqual(["chunk_1"])
  })
})
