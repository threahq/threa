import { describe, it, expect } from "vitest"
import { createDraftPanelId, parseDraftPanel, isDraftPanel } from "./panel-context"

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
