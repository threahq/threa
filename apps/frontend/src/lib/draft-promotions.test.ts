import { describe, expect, it } from "vitest"
import type { CachedEvent } from "@/db"
import {
  emitDraftPromoted,
  getDraftPromotionEvents,
  getDraftPromotionSource,
  getPromotedStreamId,
  releaseDraftPromotionEvents,
  waitForDraftPromotion,
} from "./draft-promotions"

describe("draft promotions", () => {
  it("retains both sides of a promotion for stale send callbacks and composer continuity", () => {
    emitDraftPromoted({ draftId: "draft_lookup", realStreamId: "stream_lookup", workspaceId: "ws_1" })

    expect(getPromotedStreamId("draft_lookup")).toBe("stream_lookup")
    expect(getDraftPromotionSource("stream_lookup")).toBe("draft_lookup")
  })

  it("hands the moved rows to both ids until the real stream releases them", () => {
    const moved: CachedEvent = {
      id: "temp_moved",
      workspaceId: "ws_1",
      streamId: "stream_handoff",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created",
      payload: {},
      actorId: "user_1",
      actorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      _status: "pending",
      _cachedAt: 0,
    }
    emitDraftPromoted({
      draftId: "draft_handoff",
      realStreamId: "stream_handoff",
      workspaceId: "ws_1",
      events: [moved],
    })

    expect(getDraftPromotionEvents("draft_handoff")).toEqual([moved])
    expect(getDraftPromotionEvents("stream_handoff")).toEqual([moved])

    releaseDraftPromotionEvents("stream_handoff")

    expect(getDraftPromotionEvents("draft_handoff")).toBeNull()
    expect(getDraftPromotionEvents("stream_handoff")).toBeNull()
    expect(getPromotedStreamId("draft_handoff")).toBe("stream_handoff")
  })

  it("resolves a waiter registered while materialization is in flight", async () => {
    const promoted = waitForDraftPromotion("ws_1", "draft_wait")

    emitDraftPromoted({ draftId: "draft_wait", realStreamId: "stream_wait", workspaceId: "ws_1" })

    await expect(promoted).resolves.toBe("stream_wait")
  })

  it("rejects and removes a waiter when its composer unmounts", async () => {
    const controller = new AbortController()
    const promoted = waitForDraftPromotion("ws_1", "draft_abort", { signal: controller.signal })

    controller.abort()

    await expect(promoted).rejects.toMatchObject({ name: "AbortError" })
  })

  it("bounds a wait when materialization keeps failing", async () => {
    const promoted = waitForDraftPromotion("ws_1", "draft_timeout", { timeoutMs: 1 })

    await expect(promoted).rejects.toThrow("Timed out waiting for draft promotion")
  })
})
