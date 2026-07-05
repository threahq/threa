import { describe, expect, it } from "vitest"
import { selectStaleStreamTags, type DisplayedNotification } from "./notification-sweep"

const WS = "ws_1"

function entry(tag: string, workspaceId: string | undefined = WS): DisplayedNotification {
  return { tag, workspaceId }
}

describe("selectStaleStreamTags", () => {
  const notifications = [
    entry("stream_read"), // read stream — stale
    entry("stream_read:mention"), // mention group of the read stream — stale
    entry("stream_unread"), // still unread — kept
    entry("stream_unread:mention"),
    entry("rewrap:stream_read"), // non-stream tags are never swept
    entry("session-expired"),
    entry("threa-test"),
    entry("threa-notification"),
  ]

  it("selects only stream tags whose stream has nothing unread, including the mention group", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set(["stream_unread"]))).toEqual([
      "stream_read",
      "stream_read:mention",
    ])
  })

  it("selects all stream tags when nothing is unread, leaving system tags alone", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set())).toEqual([
      "stream_read",
      "stream_read:mention",
      "stream_unread",
      "stream_unread:mention",
    ])
  })

  it("selects nothing when every displayed stream is still unread", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set(["stream_read", "stream_unread"]))).toEqual([])
  })

  it("never touches another workspace's notifications — their streams are always absent from this keep-set", () => {
    const foreign: DisplayedNotification[] = [
      entry("stream_other_ws", "ws_2"),
      { tag: "stream_unstamped", workspaceId: undefined },
    ]
    expect(selectStaleStreamTags(foreign, WS, new Set())).toEqual([])
  })
})
