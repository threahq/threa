import { describe, expect, it } from "vitest"
import type { CachedEvent } from "@/db"
import {
  emitDraftPromoted,
  getDraftPromotionEvents,
  getDraftPromotionSource,
  getDraftPromotionStream,
  getPromotedStreamId,
  releaseDraftPromotionEvents,
  waitForDraftPromotion,
} from "./draft-promotions"

const pendingEvent = (id: string, workspaceId: string, streamId: string): CachedEvent => ({
  id,
  workspaceId,
  streamId,
  sequence: "1",
  _sequenceNum: 1,
  eventType: "message_created",
  payload: {},
  actorId: "user_1",
  actorType: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  _status: "pending",
  _cachedAt: 0,
})

describe("draft promotions", () => {
  it("retains both sides of a promotion for stale send callbacks and composer continuity", () => {
    emitDraftPromoted({ draftId: "draft_lookup", realStreamId: "stream_lookup", workspaceId: "ws_1" })

    expect(getPromotedStreamId("ws_1", "draft_lookup")).toBe("stream_lookup")
    expect(getDraftPromotionSource("ws_1", "stream_lookup")).toBe("draft_lookup")
  })

  it("hands the moved rows to both ids until the real stream releases them", () => {
    const moved = pendingEvent("temp_moved", "ws_1", "stream_handoff")
    emitDraftPromoted({
      draftId: "draft_handoff",
      realStreamId: "stream_handoff",
      workspaceId: "ws_1",
      events: [moved],
    })

    expect(getDraftPromotionEvents("ws_1", "draft_handoff")).toEqual([moved])
    expect(getDraftPromotionEvents("ws_1", "stream_handoff")).toEqual([moved])

    releaseDraftPromotionEvents("ws_1", "stream_handoff")

    expect(getDraftPromotionEvents("ws_1", "draft_handoff")).toBeNull()
    expect(getDraftPromotionEvents("ws_1", "stream_handoff")).toBeNull()
    expect(getPromotedStreamId("ws_1", "draft_handoff")).toBe("stream_handoff")
  })

  it("should keep a promotion invisible to another workspace when both promote the same ids", () => {
    const eventFor = (workspaceId: string) => pendingEvent(`temp_${workspaceId}`, workspaceId, "stream_shared")
    const eventA = eventFor("ws_a")

    emitDraftPromoted({
      draftId: "draft_shared",
      realStreamId: "stream_shared",
      workspaceId: "ws_a",
      events: [eventA],
    })

    expect({
      promotedStreamId: getPromotedStreamId("ws_b", "draft_shared"),
      source: getDraftPromotionSource("ws_b", "stream_shared"),
      eventsByDraft: getDraftPromotionEvents("ws_b", "draft_shared"),
      eventsByStream: getDraftPromotionEvents("ws_b", "stream_shared"),
      stream: getDraftPromotionStream("ws_b", "stream_shared"),
    }).toEqual({ promotedStreamId: null, source: null, eventsByDraft: null, eventsByStream: null, stream: null })

    releaseDraftPromotionEvents("ws_b", "stream_shared")

    expect(getDraftPromotionEvents("ws_a", "stream_shared")).toEqual([eventA])

    emitDraftPromoted({
      draftId: "draft_shared",
      realStreamId: "stream_shared",
      workspaceId: "ws_b",
      events: [eventFor("ws_b")],
    })
    releaseDraftPromotionEvents("ws_b", "stream_shared")

    expect({
      a: getDraftPromotionEvents("ws_a", "draft_shared"),
      b: getDraftPromotionEvents("ws_b", "draft_shared"),
    }).toEqual({ a: [eventA], b: null })
  })

  it("resolves a waiter registered while materialization is in flight", async () => {
    const promoted = waitForDraftPromotion("ws_1", "draft_wait")

    emitDraftPromoted({ draftId: "draft_wait", realStreamId: "stream_wait", workspaceId: "ws_1" })

    await expect(promoted).resolves.toBe("stream_wait")
  })

  it("should resolve a wait from an already-recorded promotion only in its own workspace", async () => {
    emitDraftPromoted({ draftId: "draft_recorded", realStreamId: "stream_recorded", workspaceId: "ws_a" })

    await expect(waitForDraftPromotion("ws_a", "draft_recorded")).resolves.toBe("stream_recorded")
    await expect(waitForDraftPromotion("ws_b", "draft_recorded", { timeoutMs: 1 })).rejects.toThrow(
      "Timed out waiting for draft promotion"
    )
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
