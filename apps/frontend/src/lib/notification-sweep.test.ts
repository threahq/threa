import { describe, expect, it } from "vitest"
import { selectStaleStreamTags } from "./notification-sweep"

describe("selectStaleStreamTags", () => {
  const tags = [
    "stream_read", // read stream — stale
    "stream_read:mention", // mention group of the read stream — stale
    "stream_unread", // still unread — kept
    "stream_unread:mention",
    "rewrap:stream_read", // non-stream tags are never swept
    "session-expired",
    "threa-test",
    "threa-notification",
  ]

  it("selects only stream tags whose stream has nothing unread, including the mention group", () => {
    expect(selectStaleStreamTags(tags, new Set(["stream_unread"]))).toEqual(["stream_read", "stream_read:mention"])
  })

  it("selects all stream tags when nothing is unread, leaving system tags alone", () => {
    expect(selectStaleStreamTags(tags, new Set())).toEqual([
      "stream_read",
      "stream_read:mention",
      "stream_unread",
      "stream_unread:mention",
    ])
  })

  it("selects nothing when every displayed stream is still unread", () => {
    expect(selectStaleStreamTags(tags, new Set(["stream_read", "stream_unread"]))).toEqual([])
  })
})
