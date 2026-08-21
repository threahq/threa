import { describe, expect, test } from "bun:test"
import { ContextIntents, ContextRefKinds, VIEWPORT_MAX_VISIBLE_IDS } from "@threa/types"
import { contextBagSchema } from "./schemas"

const viewportRef = {
  kind: ContextRefKinds.VIEWPORT,
  streamId: "stream_host",
  visibleMessageIds: ["msg_a", "msg_b"],
  capturedAt: "2026-08-21T10:00:00.000Z",
}

describe("contextBagSchema — viewport refs", () => {
  test("accepts an aside bag with a viewport ref", () => {
    const parsed = contextBagSchema.parse({ intent: ContextIntents.ASIDE, refs: [viewportRef] })
    expect(parsed.refs[0]).toEqual(viewportRef)
  })

  test("rejects a viewport with no visible ids, more than the cap, or a malformed capture time", () => {
    const bag = (ref: Record<string, unknown>) =>
      contextBagSchema.safeParse({ intent: ContextIntents.ASIDE, refs: [ref] }).success
    expect(bag({ ...viewportRef, visibleMessageIds: [] })).toBe(false)
    expect(bag({ ...viewportRef, visibleMessageIds: Array(VIEWPORT_MAX_VISIBLE_IDS + 1).fill("msg_x") })).toBe(false)
    expect(bag({ ...viewportRef, visibleMessageIds: Array(VIEWPORT_MAX_VISIBLE_IDS).fill("msg_x") })).toBe(true)
    expect(bag({ ...viewportRef, capturedAt: "yesterday" })).toBe(false)
  })
})
