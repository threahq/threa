import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Draft, JSONContent, UpsertDraftInput, UpsertDraftResponse } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import {
  applyDraftDeleted,
  applyDraftsBootstrap,
  applyDraftUpserted,
  cachedDraftFromWire,
  enqueueDraftDelete,
  enqueueDraftUpsert,
  executeDraftDelete,
  executeDraftUpsert,
  hasPendingDraftUpsert,
  type DraftsServiceLike,
} from "./draft-sync"

const workspaceId = "ws_1"
const userId = "user_1"
const scope = "stream:stream_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

function wireDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "draft_server1",
    workspaceId,
    userId,
    scope,
    rootStreamId: null,
    contentJson: makeDoc("from server"),
    contentMarkdown: "from server",
    attachmentIds: [],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    version: 1,
    clientUpdatedAt: new Date(1000).toISOString(),
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    ...overrides,
  }
}

function localDraft(overrides: Partial<CachedDraft> = {}): CachedDraft {
  return {
    id: "draft_local1",
    workspaceId,
    scope,
    contentJson: makeDoc("local"),
    attachments: [],
    clientUpdatedAt: 500,
    ...overrides,
  }
}

beforeEach(async () => {
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
  await db.pendingOperations.clear()
})

describe("cachedDraftFromWire", () => {
  it("maps version to baseVersion and parses clientUpdatedAt", () => {
    const cached = cachedDraftFromWire(wireDraft({ version: 7, attachmentIds: ["a1"] }))
    expect(cached).toMatchObject({
      id: "draft_server1",
      workspaceId,
      scope,
      baseVersion: 7,
      attachmentIds: ["a1"],
      clientUpdatedAt: 1000,
    })
    // wire row carries no display metadata, only ids
    expect(cached.attachments).toEqual([])
  })

  it("drops empty contextRefs to undefined", () => {
    expect(cachedDraftFromWire(wireDraft({ contextRefs: [] })).contextRefs).toBeUndefined()
    expect(cachedDraftFromWire(wireDraft({ contextRefs: [{ kind: "x" }] })).contextRefs).toEqual([{ kind: "x" }])
  })
})

describe("applyDraftUpserted", () => {
  it("accepts a brand-new server draft", async () => {
    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft() }, workspaceId)

    const row = await db.drafts.get("draft_server1")
    expect(row).toMatchObject({ scope, baseVersion: 1, contentJson: makeDoc("from server") })
  })

  it("ignores a workspace mismatch", async () => {
    const draft = wireDraft({ workspaceId: "other" })
    await applyDraftUpserted({ workspaceId: "other", targetUserId: userId, draft }, workspaceId)
    expect(await db.drafts.count()).toBe(0)
  })

  it("ignores an E2E (contentless) row", async () => {
    await applyDraftUpserted(
      { workspaceId, targetUserId: userId, draft: wireDraft({ contentJson: null, ciphertext: "x" }) },
      workspaceId
    )
    expect(await db.drafts.count()).toBe(0)
  })

  it("ignores a stale echo at or below the confirmed version", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 3, contentJson: makeDoc("mine") }))

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_x", version: 3, contentJson: makeDoc("echo") }),
      },
      workspaceId
    )

    expect((await db.drafts.get("draft_x"))?.contentJson).toEqual(makeDoc("mine"))
  })

  it("accepts a newer server version when there are no unpushed local edits", async () => {
    const attachments = [{ id: "att_1", filename: "f.png", mimeType: "image/png", sizeBytes: 4 }]
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, attachments, contentJson: makeDoc("old") }))

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_x", version: 2, contentJson: makeDoc("new") }),
      },
      workspaceId
    )

    const row = await db.drafts.get("draft_x")
    expect(row).toMatchObject({ baseVersion: 2, contentJson: makeDoc("new") })
    // local attachment metadata (absent on the wire) is preserved
    expect(row?.attachments).toEqual(attachments)
  })

  it("splits locally on drift — our unpushed edits and the server row both survive", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("my edits") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    // a pending push is the local "dirty" bit
    await enqueueDraftUpsert(workspaceId, "draft_x")

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_x", version: 2, contentJson: makeDoc("their edits") }),
      },
      workspaceId
    )

    // original id now holds the server row
    expect((await db.drafts.get("draft_x"))?.contentJson).toEqual(makeDoc("their edits"))

    // our edits live under a fresh id
    const all = await db.drafts.toArray()
    const ours = all.find((d) => d.id !== "draft_x")
    expect(ours?.contentJson).toEqual(makeDoc("my edits"))
    expect(ours?.baseVersion).toBe(0)

    // the composer follows our edits, and the push is re-routed to the new id
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(ours!.id)
    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await hasPendingDraftUpsert(ours!.id)).toBe(true)
  })
})

describe("applyDraftDeleted", () => {
  it("removes a clean local draft and clears its loaded pointer", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })

    await applyDraftDeleted({ workspaceId, targetUserId: userId, draftId: "draft_x" }, workspaceId)

    expect(await db.drafts.get("draft_x")).toBeUndefined()
    expect((await db.composerLoaded.get(scope))?.draftId).toBeUndefined()
  })

  it("preserves unpushed local edits as a fresh draft instead of deleting (no-loss)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("my edits") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    await enqueueDraftUpsert(workspaceId, "draft_x") // a queued push = unpushed local edits

    await applyDraftDeleted({ workspaceId, targetUserId: userId, draftId: "draft_x" }, workspaceId)

    // The deleted id is gone, but our edits survive under a fresh, never-confirmed id.
    expect(await db.drafts.get("draft_x")).toBeUndefined()
    const ours = (await db.drafts.toArray()).find((d) => d.id !== "draft_x")
    expect(ours?.contentJson).toEqual(makeDoc("my edits"))
    expect(ours?.baseVersion).toBe(0)
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(ours!.id)
    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await hasPendingDraftUpsert(ours!.id)).toBe(true)
  })
})

describe("applyDraftsBootstrap", () => {
  it("applies server drafts, drops confirmed-absent locals, and queues unsynced locals", async () => {
    // a never-synced local draft → should be queued for its first push
    await db.drafts.put(localDraft({ id: "draft_unsynced", baseVersion: undefined }))
    // a previously-confirmed local draft absent from the server → tombstoned elsewhere
    await db.drafts.put(localDraft({ id: "draft_gone", baseVersion: 4 }))

    await applyDraftsBootstrap(workspaceId, [wireDraft({ id: "draft_server1", version: 1 })])

    expect(await db.drafts.get("draft_server1")).toBeDefined()
    expect(await db.drafts.get("draft_gone")).toBeUndefined()
    expect(await db.drafts.get("draft_unsynced")).toBeDefined()
    expect(await hasPendingDraftUpsert("draft_unsynced")).toBe(true)
  })

  it("keeps a confirmed-absent draft that still has unpushed edits", async () => {
    await db.drafts.put(localDraft({ id: "draft_dirty", baseVersion: 4 }))
    await enqueueDraftUpsert(workspaceId, "draft_dirty")

    await applyDraftsBootstrap(workspaceId, [])

    expect(await db.drafts.get("draft_dirty")).toBeDefined()
  })
})

describe("enqueueDraftUpsert / enqueueDraftDelete", () => {
  it("coalesces to a single upsert op per draft id", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftUpsert(workspaceId, "draft_y")

    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    expect(ops.filter((o) => o.payload.draftId === "draft_x")).toHaveLength(1)
    expect(ops.filter((o) => o.payload.draftId === "draft_y")).toHaveLength(1)
  })

  it("enqueueDraftDelete drops a queued push and adds a delete", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftDelete(workspaceId, "draft_x")

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.filter((o) => o.payload.draftId === "draft_x")).toHaveLength(1)
  })
})

describe("executeDraftUpsert", () => {
  function service(upsert: DraftsServiceLike["upsert"]): DraftsServiceLike {
    return { upsert, delete: vi.fn(async () => {}) }
  }

  it("pushes expectedVersion = baseVersion and confirms the returned version without clobbering content", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 2, contentJson: makeDoc("typed") }))
    const calls: UpsertDraftInput[] = []
    const upsert = vi.fn(async (_w: string, id: string, input: UpsertDraftInput): Promise<UpsertDraftResponse> => {
      calls.push(input)
      return { draft: wireDraft({ id, version: 3, contentJson: makeDoc("server-derived") }), split: false }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    expect(calls[0]).toMatchObject({ scope, expectedVersion: 2, writeId: "write_a", contentJson: makeDoc("typed") })
    const row = await db.drafts.get("draft_x")
    expect(row?.baseVersion).toBe(3)
    // local content is NOT overwritten with the server's derived copy
    expect(row?.contentJson).toEqual(makeDoc("typed"))
  })

  it("migrates the local id to the server-minted id on a split", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("mine") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    const upsert = vi.fn(
      async (_w: string, id: string): Promise<UpsertDraftResponse> => ({
        draft: wireDraft({ id: "draft_new", version: 1 }),
        split: true,
        originalId: id,
      })
    )

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    expect(await db.drafts.get("draft_x")).toBeUndefined()
    const migrated = await db.drafts.get("draft_new")
    expect(migrated).toMatchObject({ contentJson: makeDoc("mine"), baseVersion: 1 })
    expect((await db.composerLoaded.get(scope))?.draftId).toBe("draft_new")
  })

  it("reads the draft fresh and no-ops when it was deleted after enqueue", async () => {
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => ({ draft: wireDraft(), split: false }))
    await executeDraftUpsert(workspaceId, "draft_missing", "write_a", service(upsert))
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe("executeDraftDelete", () => {
  it("delegates to the service", async () => {
    const del = vi.fn(async () => {})
    await executeDraftDelete(workspaceId, "draft_x", { upsert: vi.fn(), delete: del } as unknown as DraftsServiceLike)
    expect(del).toHaveBeenCalledWith(workspaceId, "draft_x")
  })
})
