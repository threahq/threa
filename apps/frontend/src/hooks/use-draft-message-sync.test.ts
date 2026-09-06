import { describe, it, expect, beforeEach } from "vitest"
import {
  clearLoadedDraft,
  purgeScopeDrafts,
  relocateLoadedDraft,
  rescopeScopeDrafts,
  upsertLoadedDraft,
} from "./use-draft-message"
import { readStagedDraft, stageDraftContent } from "@/lib/drafts/draft-staging"
import { hasPendingDraftUpsert } from "@/sync/draft-sync"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import type { JSONContent } from "@threahq/types"

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

async function pendingUpserts(draftId: string): Promise<number> {
  const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
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

  it("preserves baseVersion across edits and keeps the same id (no split-on-every-keystroke)", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("h"), attachments: [] })
    // Simulate the server confirming the first push at version 1.
    await db.drafts.put({ ...(await db.drafts.get(row.id))!, baseVersion: 1 })

    // Editing the already-confirmed draft must not reset baseVersion (which would
    // make the next push expectedVersion 0 and split server-side into a copy).
    const updated = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("he"), attachments: [] })

    expect(updated.id).toBe(row.id)
    expect(await db.drafts.count()).toBe(1)
    expect((await db.drafts.get(row.id))?.baseVersion).toBe(1)
    // The loaded draft is never also a stash entry — exactly one pointer at it.
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(row.id)
  })

  it("clearLoadedDraft queues an idempotent cleanup delete for a never-confirmed draft", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi"), attachments: [] })

    await clearLoadedDraft(workspaceId, scope)

    expect(await hasPendingDraftUpsert(row.id)).toBe(false)
    expect(await pendingDeletes(row.id)).toBe(1)
  })

  it("clearLoadedDraft enqueues a server delete for a confirmed draft", async () => {
    const row = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("hi"), attachments: [] })
    // Simulate a server confirmation.
    await db.drafts.put({ ...row, baseVersion: 1 })

    await clearLoadedDraft(workspaceId, scope)

    expect(await pendingDeletes(row.id)).toBe(1)
    expect(await db.drafts.get(row.id)).toBeUndefined()
  })

  it("purgeScopeDrafts queues cleanup deletes for confirmed and never-confirmed rows", async () => {
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
    expect(await pendingDeletes(unsyncedRow.id)).toBe(1)
    expect(await db.drafts.count()).toBe(0)
  })

  it("rescopeScopeDrafts moves every draft (and the loaded pointer) to the new scope and pushes each", async () => {
    const fromScope = "stream:draft_local_stream"
    const toScope = "stream:stream_real"
    // The loaded draft for the scratchpad, plus a stash sibling.
    const loadedRow = await upsertLoadedDraft(workspaceId, fromScope, {
      contentJson: makeDoc("loaded"),
      attachments: [],
    })
    const stashRow: CachedDraft = {
      id: "draft_stash",
      workspaceId,
      scope: fromScope,
      contentJson: makeDoc("stash"),
      attachments: [],
      clientUpdatedAt: Date.now(),
    }
    await db.drafts.add(stashRow)

    await rescopeScopeDrafts(workspaceId, fromScope, toScope)

    // Both rows kept their ids but moved to the real stream scope.
    expect((await db.drafts.get(loadedRow.id))?.scope).toBe(toScope)
    expect((await db.drafts.get("draft_stash"))?.scope).toBe(toScope)
    // The loaded pointer followed its draft to the new scope; the old scope is empty.
    expect((await db.composerLoaded.get(fromScope))?.draftId).toBeUndefined()
    expect((await db.composerLoaded.get(toScope))?.draftId).toBe(loadedRow.id)
    // Each draft is queued for a push so the server row follows.
    expect(await pendingUpserts(loadedRow.id)).toBe(1)
    expect(await pendingUpserts("draft_stash")).toBe(1)
  })

  it("rescopeScopeDrafts moves the crash-safe staging buffer with the scope", async () => {
    // A staged keystroke left under the old scope no longer matches any IDB row
    // there after the move, so the startup reconcile would "recover" it —
    // resurrecting the draft under the scope the user just moved it out of
    // (live repro: cancel-armed-branch-reply left a duplicate branch draft).
    const fromScope = "board:branch-reply:conv_a"
    const toScope = "board:reply:conv_root"
    await upsertLoadedDraft(workspaceId, fromScope, { contentJson: makeDoc("moving"), attachments: [] })
    stageDraftContent(workspaceId, fromScope, makeDoc("moving"))

    await rescopeScopeDrafts(workspaceId, fromScope, toScope)

    expect(readStagedDraft(workspaceId, fromScope)).toBeNull()
    expect(readStagedDraft(workspaceId, toScope)?.contentJson).toEqual(makeDoc("moving"))
  })

  it("relocateLoadedDraft keeps one identity while displacing an existing target draft", async () => {
    const fromScope = "board:branch-reply:conv_move"
    const toScope = "board:reply:conv_move_root"
    const sourceRow = await upsertLoadedDraft(workspaceId, fromScope, {
      contentJson: makeDoc("live keystrokes"),
      attachments: [],
    })
    const existingTarget = await upsertLoadedDraft(workspaceId, toScope, {
      contentJson: makeDoc("root already had this"),
      attachments: [],
    })
    const sourceOp = (await db.pendingOperations.where("type").equals("upsert_draft").toArray()).find(
      (op) => op.payload.draftId === sourceRow.id
    )

    const moved = await relocateLoadedDraft(workspaceId, fromScope, toScope)

    expect(moved?.id).toBe(sourceRow.id)
    expect((await db.composerLoaded.get(fromScope))?.draftId).toBeUndefined()
    expect((await db.composerLoaded.get(toScope))?.draftId).toBe(sourceRow.id)
    expect(await db.drafts.get(sourceRow.id)).toMatchObject({
      id: sourceRow.id,
      scope: toScope,
      contentJson: makeDoc("live keystrokes"),
    })
    expect(await pendingDeletes(sourceRow.id)).toBe(0)
    expect(await pendingUpserts(sourceRow.id)).toBe(1)
    const movedOp = (await db.pendingOperations.where("type").equals("upsert_draft").toArray()).find(
      (op) => op.payload.draftId === sourceRow.id
    )
    expect(movedOp?.id).not.toBe(sourceOp?.id)
    expect(movedOp?.payload.priorWriteIds).toContain(sourceOp?.payload.writeId)
    // The target's previous loaded draft survives as a pile sibling (no-loss).
    expect(await db.drafts.get(existingTarget.id)).toMatchObject({
      scope: toScope,
      contentJson: makeDoc("root already had this"),
    })
  })

  it("rescopeScopeDrafts supersedes a queued push with a fresh op carrying its writeId lineage", async () => {
    // The queue worker claims an op and snapshots the row in separate
    // transactions, so a pre-move push can be in flight while its claim is not
    // yet visible. Coalescing onto that op loses the scope move when it
    // completes; the rescope must always mint a fresh op whose priorWriteIds
    // carry the old lineage so the extra push stays idempotent.
    const fromScope = "board:branch-reply:conv_b"
    const toScope = "board:reply:conv_root2"
    const row = await upsertLoadedDraft(workspaceId, fromScope, { contentJson: makeDoc("racing"), attachments: [] })
    const before = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const priorOp = before.find((o) => o.payload.draftId === row.id)
    expect(priorOp).toBeDefined()

    await rescopeScopeDrafts(workspaceId, fromScope, toScope)

    const after = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const ops = after.filter((o) => o.payload.draftId === row.id)
    expect(ops).toHaveLength(1)
    expect(ops[0].id).not.toBe(priorOp?.id)
    expect(ops[0].payload.priorWriteIds).toContain(priorOp?.payload.writeId)
  })
})
