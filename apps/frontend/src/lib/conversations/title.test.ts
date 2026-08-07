import { describe, expect, test } from "vitest"
import { effectiveConversationTitle } from "./title"

const conversation = { streamId: "stream_1", topicSummary: "**Legacy topic**" }

describe("effectiveConversationTitle", () => {
  test("uses the current scratchpad stream overlay and strips preview markdown", () => {
    expect(
      effectiveConversationTitle(conversation, {
        id: "stream_1",
        type: "scratchpad",
        displayName: "**Decrypted name**",
      })
    ).toBe("Decrypted name")
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
