import { describe, expect, test } from "vitest"
import { StreamTypes } from "@threahq/types"
import { STREAM_ICONS } from "@/lib/streams"
import { streamTypeVisual } from "@/lib/stream-visuals"

describe("streamTypeVisual", () => {
  test("a doc gets the doc glyph, not the thread fallback", () => {
    expect(streamTypeVisual(StreamTypes.DOC).Icon).toBe(STREAM_ICONS[StreamTypes.DOC])
    expect(streamTypeVisual(StreamTypes.DOC).Icon).not.toBe(streamTypeVisual(StreamTypes.THREAD).Icon)
  })
})
