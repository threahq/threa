import { describe, it, expect } from "vitest"
import { isServerStreamId } from "@/lib/stream-ids"
import { formatPanelLayout, parsePanelLayout } from "@/lib/panel-tabs"
import {
  createConversationsPanelId,
  isConversationPanel,
  parseConversationPanel,
  parseConversationsPanel,
  createDraftPanelId,
  parseDraftPanel,
  isDraftPanel,
} from "./panel-context"

describe("draft panel id round-trip", () => {
  it("round-trips a message anchor, byte-identical to the pre-anchor format", () => {
    const id = createDraftPanelId("stream_1", "msg_anchor")
    expect(id).toBe("draft:stream_1:msg_anchor")
    expect(isDraftPanel(id)).toBe(true)
    expect(parseDraftPanel(id)).toEqual({ parentStreamId: "stream_1", anchorId: "msg_anchor" })
  })

  it("round-trips a card (event) anchor through the same opaque format", () => {
    const id = createDraftPanelId("stream_1", "event_card")
    expect(id).toBe("draft:stream_1:event_card")
    expect(parseDraftPanel(id)).toEqual({ parentStreamId: "stream_1", anchorId: "event_card" })
  })

  it("returns null for a non-draft panel id", () => {
    expect(parseDraftPanel("stream_1")).toBeNull()
    expect(parseDraftPanel("draft:only-two")).toBeNull()
  })
})

describe("conversations list panel id", () => {
  it("parses back to its stream and is neither a conversation nor a server stream", () => {
    const id = createConversationsPanelId("stream_1")
    expect({
      id,
      stream: parseConversationsPanel(id),
      malformed: parseConversationsPanel("convs:"),
      notOne: parseConversationsPanel("conv:conv_1"),
      asConversation: isConversationPanel(id) || parseConversationPanel(id) !== null,
      server: isServerStreamId(id),
    }).toEqual({
      id: "convs:stream_1",
      stream: "stream_1",
      malformed: null,
      notOne: null,
      asConversation: false,
      server: false,
    })
  })

  it("round-trips through ?panel= beside its stream", () => {
    const layout = parsePanelLayout("stream_1*.convs:stream_1.conv:conv_1")
    expect(formatPanelLayout(layout)).toBe("stream_1*.convs:stream_1.conv:conv_1")
  })
})
