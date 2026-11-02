import { afterEach, describe, expect, test } from "vitest"
import {
  applyDecryptedNameOverlay,
  clearStreamNameCache,
  primeStreamName,
  streamNameCacheKey,
} from "@/lib/crypto/stream-name-cache"
import { effectiveConversationTitle } from "./title"

const conversation = { streamId: "stream_1", topicSummary: "**Legacy topic**" }

afterEach(clearStreamNameCache)

describe("effectiveConversationTitle", () => {
  test("uses a plaintext scratchpad title and strips preview markdown", () => {
    expect(
      effectiveConversationTitle(conversation, {
        id: "stream_1",
        type: "scratchpad",
        displayName: "**Scratchpad name**",
        e2eEnabled: false,
      })
    ).toBe("Scratchpad name")
  })

  test("uses only the memory-only decrypted title for an E2E scratchpad", () => {
    const stream = {
      id: "stream_1",
      type: "scratchpad" as const,
      displayName: "Legacy plaintext title",
      e2eEnabled: true,
    }
    expect(effectiveConversationTitle(conversation, stream)).toBeNull()
    expect(effectiveConversationTitle(conversation, stream, "**Decrypted name**")).toBe("Decrypted name")
    const sealedStream = { ...stream, sealedNameCiphertext: "ciphertext" }
    primeStreamName(streamNameCacheKey("workspace_1", stream.id, "ciphertext"), "**Overlaid decrypted name**")
    const [overlaid] = applyDecryptedNameOverlay("workspace_1", [sealedStream])
    expect(effectiveConversationTitle(conversation, overlaid)).toBe("Overlaid decrypted name")
  })

  test("ignores a scratchpad stream that is not the conversation root", () => {
    expect(
      effectiveConversationTitle(conversation, { id: "stream_other", type: "scratchpad", displayName: "Other" })
    ).toBe("Legacy topic")
  })

  test("preserves non-scratchpad conversation ownership", () => {
    expect(effectiveConversationTitle(conversation, { id: "stream_1", type: "channel", displayName: "Channel" })).toBe(
      "Legacy topic"
    )
  })
})
