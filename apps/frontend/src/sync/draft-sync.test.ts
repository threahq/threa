import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Draft, JSONContent, UpsertDraftInput, UpsertDraftResponse } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import {
  applyDraftDeleted,
  applyDraftsBootstrap,
  applyDraftUpserted,
  cachedDraftFromWire,
  deleteDraftById,
  enqueueDraftDelete,
  enqueueDraftResolve,
  enqueueDraftUpsert,
  executeDraftDelete,
  executeDraftResolve,
  executeDraftUpsert,
  hasPendingDraftUpsert,
  syncDraftResolution,
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

  it("maps the E2E triple and uses the placeholder body for a sealed row", () => {
    const row = cachedDraftFromWire(
      wireDraft({ contentJson: null, ciphertext: "ct", envelope: { v: 2 }, e2eVersion: 2 })
    )
    expect(row).toMatchObject({ ciphertext: "ct", e2eVersion: 2 })
    expect(row.contentJson).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("leaves the E2E fields unset for a plaintext row", () => {
    const row = cachedDraftFromWire(wireDraft())
    expect(row.ciphertext).toBeUndefined()
    expect(row.envelope).toBeUndefined()
    expect(row.e2eVersion).toBeUndefined()
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

  it("accepts an E2E (sealed) row, storing the ciphertext and a placeholder body", async () => {
    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ contentJson: null, ciphertext: "ct_x", envelope: { v: 2 }, e2eVersion: 2 }),
      },
      workspaceId
    )

    const row = await db.drafts.get("draft_server1")
    expect(row).toMatchObject({ scope, baseVersion: 1, ciphertext: "ct_x", e2eVersion: 2 })
    // No plaintext at rest — the body lives in `ciphertext`; `contentJson` is the placeholder.
    expect(row?.contentJson).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
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

  it("ignores an inbound newer version while we have unpushed edits — no client-side split (server arbitrates)", async () => {
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

    // Exactly one draft remains: our edits, untouched. No duplicate is minted —
    // the queued push will reach the server, which splits CAS-safely if it's a
    // real drift (executeDraftUpsert then migrates our id). Splitting here too is
    // what forked our own in-flight echo into duplicates.
    expect(await db.drafts.count()).toBe(1)
    const row = await db.drafts.get("draft_x")
    expect(row?.contentJson).toEqual(makeDoc("my edits"))
    expect(row?.baseVersion).toBe(1)
    expect((await db.composerLoaded.get(scope))?.draftId).toBe("draft_x")
    expect(await hasPendingDraftUpsert("draft_x")).toBe(true)
  })

  it("re-points the loaded draft to the new scope when the server re-scopes it (thread conversion)", async () => {
    const oldScope = "thread:msg_1"
    const newScope = "stream:thread_1"
    await db.drafts.put(localDraft({ id: "draft_x", scope: oldScope, baseVersion: 1, contentJson: makeDoc("reply") }))
    await db.composerLoaded.put({ scope: oldScope, workspaceId, draftId: "draft_x" })

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_x", scope: newScope, version: 2, contentJson: makeDoc("reply") }),
      },
      workspaceId
    )

    // The draft (same id) now lives under the thread stream scope...
    const row = await db.drafts.get("draft_x")
    expect(row).toMatchObject({ scope: newScope, baseVersion: 2 })
    // ...and the device-local loaded pointer followed it: the old scope is empty,
    // the new scope points at the draft, so the reply isn't stranded.
    expect((await db.composerLoaded.get(oldScope))?.draftId).toBeUndefined()
    expect((await db.composerLoaded.get(newScope))?.draftId).toBe("draft_x")
  })

  it("re-scopes a non-loaded (stash) draft without creating a pointer", async () => {
    const oldScope = "thread:msg_1"
    const newScope = "stream:thread_1"
    await db.drafts.put(localDraft({ id: "draft_stash", scope: oldScope, baseVersion: 1 }))
    // no composerLoaded row for either scope — this draft was a stash entry

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_stash", scope: newScope, version: 2 }),
      },
      workspaceId
    )

    expect((await db.drafts.get("draft_stash"))?.scope).toBe(newScope)
    expect((await db.composerLoaded.get(newScope))?.draftId).toBeUndefined()
  })

  it("does not duplicate on an echo of our own in-flight write (echo-before-ack)", async () => {
    // Brand-new draft mid-first-push: baseVersion still 0, push still queued.
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 0, contentJson: makeDoc("hello") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    await enqueueDraftUpsert(workspaceId, "draft_x")

    // The server's echo of our own insert arrives before the PUT's HTTP ack.
    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_x", version: 1, contentJson: makeDoc("hello") }),
      },
      workspaceId
    )

    expect(await db.drafts.count()).toBe(1)
    expect((await db.composerLoaded.get(scope))?.draftId).toBe("draft_x")
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

  it("enqueueDraftResolve drops a queued push and adds a CAS resolve carrying expectedVersion", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftResolve(workspaceId, "draft_x", 3)

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    const forDraft = resolves.filter((o) => o.payload.draftId === "draft_x")
    expect(forDraft).toHaveLength(1)
    expect(forDraft[0]?.payload.expectedVersion).toBe(3)
  })
})

describe("syncDraftResolution", () => {
  it("enqueues a CAS resolve for a confirmed draft (baseVersion > 0)", async () => {
    await syncDraftResolution(workspaceId, "draft_x", 4)

    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    expect(resolves.filter((o) => o.payload.draftId === "draft_x" && o.payload.expectedVersion === 4)).toHaveLength(1)
  })

  it("only drops the pending push for a never-synced draft (nothing to resolve server-side)", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await syncDraftResolution(workspaceId, "draft_x", 0)

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await db.pendingOperations.where("type").equals("resolve_draft").count()).toBe(0)
  })
})

describe("executeDraftUpsert", () => {
  function service(upsert: DraftsServiceLike["upsert"]): DraftsServiceLike {
    return { upsert, resolve: vi.fn(async () => ({ resolved: true })), delete: vi.fn(async () => {}) }
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

  it("pushes the ciphertext triple (never plaintext or attachment linkage) for an E2E draft", async () => {
    await db.drafts.put(
      localDraft({
        id: "draft_e2e",
        baseVersion: 1,
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        ciphertext: "ct_sealed",
        envelope: { v: 2 },
        e2eVersion: 2,
        // A stray attachment id (e.g. carried by a pre-seal wire row): it must NOT
        // ship alongside the ciphertext — v1 is body-only and an E2E row leaks no
        // plaintext attachment linkage (E2EE-4).
        attachmentIds: ["a_leak"],
      })
    )
    const calls: UpsertDraftInput[] = []
    const upsert = vi.fn(async (_w: string, id: string, input: UpsertDraftInput): Promise<UpsertDraftResponse> => {
      calls.push(input)
      return {
        draft: wireDraft({ id, version: 2, contentJson: null, ciphertext: "ct_sealed", e2eVersion: 2 }),
        split: false,
      }
    })

    await executeDraftUpsert(workspaceId, "draft_e2e", "write_a", service(upsert))

    // The sealed body goes on the wire; plaintext does not (the upsert schema rejects both),
    // and the sealed push carries no attachment ids.
    expect(calls[0]).toMatchObject({ ciphertext: "ct_sealed", e2eVersion: 2, contentJson: null, attachmentIds: [] })
    expect((await db.drafts.get("draft_e2e"))?.baseVersion).toBe(2)
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

  it("re-routes the queued push to the migrated id on a split (mid-push edits aren't stranded)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("mine") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    await enqueueDraftUpsert(workspaceId, "draft_x") // edits typed during the in-flight push
    const upsert = vi.fn(
      async (_w: string, id: string): Promise<UpsertDraftResponse> => ({
        draft: wireDraft({ id: "draft_new", version: 1 }),
        split: true,
        originalId: id,
      })
    )

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    // The stale op for the old id is gone; the migrated draft has a fresh push so
    // its content reaches the server instead of stranding locally.
    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await hasPendingDraftUpsert("draft_new")).toBe(true)
  })

  it("reads the draft fresh and no-ops when it was deleted after enqueue", async () => {
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => ({ draft: wireDraft(), split: false }))
    await executeDraftUpsert(workspaceId, "draft_missing", "write_a", service(upsert))
    expect(upsert).not.toHaveBeenCalled()
  })

  it("deletes the ghost server row when the draft was discarded mid-push (no resurrection)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 0 }))
    // Simulate the user discarding the draft while the PUT is in flight.
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      return { draft: wireDraft({ id: "draft_x", version: 1 }), split: false }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    // The row is not re-created, and a delete is queued to remove the server ghost.
    expect(await db.drafts.get("draft_x")).toBeUndefined()
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.filter((o) => o.payload.draftId === "draft_x")).toHaveLength(1)
  })

  it("deletes the split server row when the original was discarded mid-push", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      return { draft: wireDraft({ id: "draft_new", version: 1 }), split: true, originalId: "draft_x" }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.filter((o) => o.payload.draftId === "draft_new")).toHaveLength(1)
  })
})

describe("executeDraftDelete", () => {
  it("delegates to the service", async () => {
    const del = vi.fn(async () => {})
    await executeDraftDelete(workspaceId, "draft_x", { upsert: vi.fn(), delete: del } as unknown as DraftsServiceLike)
    expect(del).toHaveBeenCalledWith(workspaceId, "draft_x")
  })
})

describe("executeDraftResolve", () => {
  it("delegates a CAS resolve carrying expectedVersion to the service", async () => {
    const resolve = vi.fn(async () => ({ resolved: true }))
    await executeDraftResolve(workspaceId, "draft_x", 5, {
      upsert: vi.fn(),
      resolve,
      delete: vi.fn(),
    } as unknown as DraftsServiceLike)
    expect(resolve).toHaveBeenCalledWith(workspaceId, "draft_x", { expectedVersion: 5 })
  })

  it("propagates a declined resolve (drift) without throwing — the drifted copy survives", async () => {
    const resolve = vi.fn(async () => ({ resolved: false }))
    await executeDraftResolve(workspaceId, "draft_x", 2, {
      upsert: vi.fn(),
      resolve,
      delete: vi.fn(),
    } as unknown as DraftsServiceLike)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe("pending local delete is authoritative (no resurrection)", () => {
  it("applyDraftUpserted ignores an inbound row whose delete is still queued", async () => {
    // The user deleted this draft here (e.g. from the Drafts view); its server
    // delete is queued but not yet drained, and the local row is already gone.
    await enqueueDraftDelete(workspaceId, "draft_server1")

    // A socket echo (or a re-seed) of the still-present server row arrives.
    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft() }, workspaceId)

    // It must NOT be re-created — the queued delete will remove it server-side.
    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("applyDraftsBootstrap does not resurrect a draft whose delete is still queued", async () => {
    await enqueueDraftDelete(workspaceId, "draft_server1")

    await applyDraftsBootstrap(workspaceId, [wireDraft()])

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("still accepts other server drafts while one has a queued delete", async () => {
    await enqueueDraftDelete(workspaceId, "draft_server1")

    await applyDraftsBootstrap(workspaceId, [wireDraft(), wireDraft({ id: "draft_server2" })])

    // The guard is scoped to the deleted id only; unrelated drafts still seed.
    expect(await db.drafts.get("draft_server1")).toBeUndefined()
    expect(await db.drafts.get("draft_server2")).toBeDefined()
  })
})

describe("deleteDraftById — the single user-initiated delete path", () => {
  it("removes the row and queues an unconditional server delete for a confirmed draft", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 3 }))

    await deleteDraftById(workspaceId, "draft_x")

    expect(await db.drafts.get("draft_x")).toBeUndefined()
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.map((o) => o.payload.draftId)).toContain("draft_x")
  })

  it("clears the loaded pointer when the deleted draft was the one loaded (composer empties)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })

    await deleteDraftById(workspaceId, "draft_x")

    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })

  it("cancels a never-synced draft's push instead of queuing a server delete", async () => {
    await db.drafts.put(localDraft({ id: "draft_x" })) // never confirmed → no baseVersion
    await enqueueDraftUpsert(workspaceId, "draft_x")

    await deleteDraftById(workspaceId, "draft_x")

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await db.pendingOperations.where("type").equals("delete_draft").toArray()).toHaveLength(0)
  })

  it("no-ops on an already-gone row", async () => {
    await deleteDraftById(workspaceId, "draft_missing")

    expect(await db.pendingOperations.where("type").equals("delete_draft").toArray()).toHaveLength(0)
  })
})
