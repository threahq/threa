import { describe, expect, it } from "vitest"
import {
  emitDraftPromoted,
  getDraftPromotionSource,
  getPromotedStreamId,
  waitForDraftPromotion,
} from "./draft-promotions"

describe("draft promotions", () => {
  it("retains both sides of a promotion for stale send callbacks and composer continuity", () => {
    emitDraftPromoted({ draftId: "draft_lookup", realStreamId: "stream_lookup", workspaceId: "ws_1" })

    expect(getPromotedStreamId("draft_lookup")).toBe("stream_lookup")
    expect(getDraftPromotionSource("stream_lookup")).toBe("draft_lookup")
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
