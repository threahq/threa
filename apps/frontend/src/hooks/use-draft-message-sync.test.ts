import { describe, it, expect, beforeEach } from "vitest"
import { clearLoadedDraft, purgeScopeDrafts, upsertLoadedDraft } from "./use-draft-message"
import { hasPendingDraftUpsert } from "@/sync/draft-sync"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import type { JSONContent } from "@threa/types"

const workspaceId = "ws_1"
const scope = "stream:stream_1"
const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

async function pendingDeletes(draftId: string): Promise<number> {
  const ops = await db.pendingOperations.where("type").equals("delete_draft").toArray()
  return ops.filter((o) => o.payload.draftId === draftId).length
}

beforeEach(async () => {
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
})

describe("draft write helpers — Stage 3 sync wiring", () => {
  it("upsertLoadedDraft enqueues a coalesced push for the loaded draft", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi"), attachments: [] })
    expect(await hasPendingDraftUpsert(row.id)).toBe(true)

    // A second save coalesces onto the same single op.
    await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi there"), attachments: [] })
    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    expect(ops.filter((o) => o.payload.draftId === row.id)).toHaveLength(1)
  })

  it("clearLoadedDraft cancels the push for a never-synced draft (no server delete)", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi"), attachments: [] })

    await clearLoadedDraft(workspaceId, scope)

    expect(await hasPendingDraftUpsert(row.id)).toBe(false)
    expect(await pendingDeletes(row.id)).toBe(0)
  })

  it("clearLoadedDraft enqueues a server delete for a confirmed draft", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi"), attachments: [] })
    // Simulate a server confirmation.
    await db.drafts.put({ ...row, baseVersion: 1 })

    await clearLoadedDraft(workspaceId, scope)

    expect(await pendingDeletes(row.id)).toBe(1)
    expect(await db.drafts.get(row.id)).toBeUndefined()
  })

  it("purgeScopeDrafts deletes server copies for confirmed rows and cancels pushes for unsynced ones", async () => {
    const confirmed = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("a"), attachments: [] })
    await db.drafts.put({ ...confirmed, baseVersion: 2 })
    const unsyncedRow: CachedDraft = {
      id: "draft_unsynced",
      workspaceId,
      scope,
      contentJson: makeDoc("b"),
      attachments: [],
      clientUpdatedAt: Date.now(),
    }
    await db.drafts.add(unsyncedRow)

    await purgeScopeDrafts(workspaceId, scope)

    expect(await pendingDeletes(confirmed.id)).toBe(1)
    expect(await pendingDeletes(unsyncedRow.id)).toBe(0)
    expect(await db.drafts.count()).toBe(0)
  })
})
