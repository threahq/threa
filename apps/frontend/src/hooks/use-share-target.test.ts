import { beforeEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import { db, type CachedDraft, type DraftAttachment } from "@/db"
import { resetDraftResolutionGuard } from "@/sync/draft-resolution-guard"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { useShareTarget } from "./use-share-target"

const scope = "stream:stream_1"

const attachmentA: DraftAttachment = { id: "attach_a", filename: "a.txt", mimeType: "text/plain", sizeBytes: 1 }
const attachmentB: DraftAttachment = { id: "attach_b", filename: "b.txt", mimeType: "text/plain", sizeBytes: 2 }

function draft(id: string, workspaceId: string, attachments: DraftAttachment[]): CachedDraft {
  return {
    id,
    workspaceId,
    scope,
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${id} body` }] }] },
    attachments,
    clientUpdatedAt: 1000,
  }
}

const sharedContent: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "shared text" }] }],
}

describe("saveShareContent keeps the shared attachments per workspace", () => {
  beforeEach(async () => {
    resetDraftStoreCache()
    resetDraftResolutionGuard()
    await db.drafts.clear()
    await db.composerLoaded.clear()
    await db.pendingOperations.clear()
  })

  it("should merge into its own workspace's loaded draft when another workspace has one at the same scope", async () => {
    const draftB = draft("draft_b", "ws_b", [attachmentB])
    await db.drafts.bulkPut([draft("draft_a", "ws_a", [attachmentA]), draftB])
    await db.composerLoaded.bulkPut([
      { scope, workspaceId: "ws_a", draftId: "draft_a" },
      { scope, workspaceId: "ws_b", draftId: "draft_b" },
    ])
    await seedDraftCacheFromIdb("ws_a")
    const { result } = renderHook(() => useShareTarget())

    await result.current.saveShareContent("ws_a", "stream_1", {
      title: null,
      text: "shared text",
      url: null,
      files: [],
    })

    expect(await db.drafts.orderBy("id").toArray()).toEqual([
      expect.objectContaining({
        id: "draft_a",
        workspaceId: "ws_a",
        contentJson: sharedContent,
        attachments: [attachmentA],
      }),
      draftB,
    ])
  })
})
