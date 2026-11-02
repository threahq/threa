import { describe, expect, it } from "vitest"
import { ActivityTypes } from "@threahq/types"
import { selectStaleStreamTags, type DisplayedNotification } from "./notification-sweep"
import { resolveRewrapTag, resolveTag } from "./sw-notification-format"

const WS = "ws_1"

function entry(tag: string, workspaceId: string | undefined = WS): DisplayedNotification {
  return { tag, workspaceId }
}

describe("selectStaleStreamTags", () => {
  const notifications = [
    entry("ws_1/stream_read"), // read stream — stale
    entry("ws_1/stream_read:mention"), // mention group of the read stream — stale
    entry("ws_1/stream_unread"), // still unread — kept
    entry("ws_1/stream_unread:mention"),
    entry("rewrap:ws_1/stream_read"), // non-stream tags are never swept
    entry("session-expired"),
    entry("threa-test"),
    entry("threa-notification"),
  ]

  it("selects only stream tags whose stream has nothing unread, including the mention group", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set(["stream_unread"]))).toEqual([
      "ws_1/stream_read",
      "ws_1/stream_read:mention",
    ])
  })

  it("selects all stream tags when nothing is unread, leaving system tags alone", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set())).toEqual([
      "ws_1/stream_read",
      "ws_1/stream_read:mention",
      "ws_1/stream_unread",
      "ws_1/stream_unread:mention",
    ])
  })

  it("selects nothing when every displayed stream is still unread", () => {
    expect(selectStaleStreamTags(notifications, WS, new Set(["stream_read", "stream_unread"]))).toEqual([])
  })

  it("never touches another workspace's notifications — their streams are always absent from this keep-set", () => {
    const foreign: DisplayedNotification[] = [
      entry("ws_2/stream_other_ws", "ws_2"),
      { tag: "ws_1/stream_unstamped", workspaceId: undefined },
    ]
    expect(selectStaleStreamTags(foreign, WS, new Set())).toEqual([])
  })

  it("should close only ws_a's tag when ws_a has read stream_1 and ws_b holds the same stream id", () => {
    const displayed = [
      entry("ws_a/stream_1", "ws_a"),
      entry("ws_a/stream_1:mention", "ws_a"),
      entry("ws_b/stream_1", "ws_b"),
      entry("ws_b/stream_1:mention", "ws_b"),
    ]
    expect({
      wsA: selectStaleStreamTags(displayed, "ws_a", new Set()),
      wsB: selectStaleStreamTags(displayed, "ws_b", new Set()),
    }).toEqual({
      wsA: ["ws_a/stream_1", "ws_a/stream_1:mention"],
      wsB: ["ws_b/stream_1", "ws_b/stream_1:mention"],
    })
  })

  it("should keep ws_a's tag when stream_1 is unread in ws_a and ws_b has read its copy", () => {
    const displayed = [entry("ws_a/stream_1", "ws_a"), entry("ws_b/stream_1", "ws_b")]
    expect({
      wsA: selectStaleStreamTags(displayed, "ws_a", new Set(["stream_1"])),
      wsB: selectStaleStreamTags(displayed, "ws_b", new Set()),
    }).toEqual({ wsA: [], wsB: ["ws_b/stream_1"] })
  })

  it("should select the tags the service worker shows for a read stream, but not its rewrap card", () => {
    const readMessage = resolveTag(WS, "stream_read")
    const readMention = resolveTag(WS, "stream_read", ActivityTypes.MENTION)
    const displayed = [
      entry(readMessage),
      entry(readMention),
      entry(resolveRewrapTag(WS, "stream_read")),
      entry(resolveTag(WS, "stream_unread")),
      entry(resolveTag(WS, "stream_unread", ActivityTypes.MENTION)),
    ]
    expect(selectStaleStreamTags(displayed, WS, new Set(["stream_unread"]))).toEqual([readMessage, readMention])
  })

  it("should ignore a bare legacy tag when it is stamped with the sweeping workspace", () => {
    const displayed = [entry("stream_1", "ws_a"), entry("stream_1:mention", "ws_a"), entry("ws_a/stream_1", "ws_a")]
    expect(selectStaleStreamTags(displayed, "ws_a", new Set())).toEqual(["ws_a/stream_1"])
  })
})
