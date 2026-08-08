import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Draft, JSONContent, UpsertDraftInput, UpsertDraftResponse } from "@threa/types"
import { db, type CachedDraft } from "@/db"
import * as draftStore from "@/stores/draft-store"
import { resetDraftStoreCache, seedDraftCacheFromIdb } from "@/stores/draft-store"
import { markDraftResolved, resetDraftResolutionGuard } from "./draft-resolution-guard"
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
  migrateLocalDraftId,
  reconcileStagedDrafts,
  syncDraftResolution,
  type DraftsServiceLike,
} from "./draft-sync"
import { readStagedDraft, stageDraftContent } from "@/lib/drafts/draft-staging"

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
    stashedAt: null,
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
  resetDraftResolutionGuard()
  localStorage.clear()
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

  it("round-trips stashedAt as epoch ms (null stays null)", () => {
    expect(cachedDraftFromWire(wireDraft({ stashedAt: "2026-08-06T12:00:00.000Z" })).stashedAt).toBe(
      Date.parse("2026-08-06T12:00:00.000Z")
    )
    expect(cachedDraftFromWire(wireDraft({ stashedAt: null })).stashedAt).toBeNull()
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

  it("does not drop confirmed-absent locals when the snapshot is truncated at the server cap", async () => {
    // A snapshot at the cap proves nothing about rows beyond it — absence is
    // truncation, not deletion elsewhere.
    await db.drafts.put(localDraft({ id: "draft_beyond_cap", baseVersion: 4 }))
    const capped = Array.from({ length: 500 }, (_, i) => wireDraft({ id: `draft_s${i}` }))

    await applyDraftsBootstrap(workspaceId, capped)

    expect(await db.drafts.get("draft_beyond_cap")).toBeDefined()
  })
})

describe("enqueueDraftUpsert / enqueueDraftDelete", () => {
  async function upsertOp(draftId: string) {
    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    return ops.find((o) => o.payload.draftId === draftId)
  }

  it("coalesces to a single upsert op per draft id", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftUpsert(workspaceId, "draft_y")

    const ops = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    expect(ops.filter((o) => o.payload.draftId === "draft_x")).toHaveLength(1)
    expect(ops.filter((o) => o.payload.draftId === "draft_y")).toHaveLength(1)
  })

  it("keeps a never-attempted op untouched — its writeId (idempotency key) stays stable", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    const first = await upsertOp("draft_x")

    await enqueueDraftUpsert(workspaceId, "draft_x")
    const second = await upsertOp("draft_x")

    // The op reads content fresh at drain, so re-enqueueing has nothing to add;
    // churning the writeId here is what used to break lost-ack recognition.
    expect(second?.id).toBe(first?.id)
    expect(second?.payload.writeId).toBe(first?.payload.writeId)
  })

  it("replaces an attempted op with a successor that carries its write lineage", async () => {
    // The op attempted a push (startedAt set by the queue): it may have reached
    // the server even though the client never saw the ack. A save arriving now
    // must chain the old writeId so the server can recognize the lineage and
    // update in place instead of splitting a same-device duplicate.
    await enqueueDraftUpsert(workspaceId, "draft_x")
    const first = await upsertOp("draft_x")
    await db.pendingOperations.update(first!.id, { startedAt: Date.now() })

    await enqueueDraftUpsert(workspaceId, "draft_x")
    const second = await upsertOp("draft_x")

    expect(second?.id).not.toBe(first?.id)
    expect(second?.payload.writeId).not.toBe(first?.payload.writeId)
    expect(second?.payload.priorWriteIds).toEqual([first?.payload.writeId])

    // A third replacement accumulates the whole chain.
    await db.pendingOperations.update(second!.id, { startedAt: Date.now() })
    await enqueueDraftUpsert(workspaceId, "draft_x")
    const third = await upsertOp("draft_x")
    expect(third?.payload.priorWriteIds).toEqual([second?.payload.writeId, first?.payload.writeId])
  })

  it("enqueueDraftDelete drops a queued push and adds a delete", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await enqueueDraftDelete(workspaceId, "draft_x")

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.filter((o) => o.payload.draftId === "draft_x")).toHaveLength(1)
  })

  it("enqueueDraftDelete carries the dropped push's write lineage onto the delete", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    const op = await upsertOp("draft_x")
    const writeId = op?.payload.writeId as string

    await enqueueDraftDelete(workspaceId, "draft_x")

    // If that push already left the device, its late landing must read as
    // discarded content — the tombstone needs the lineage to drop it.
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    const del = dels.find((o) => o.payload.draftId === "draft_x")
    expect(del?.payload.supersededWriteIds).toEqual([writeId])
  })

  it("enqueueDraftResolve keeps a queued push as the in-flight echo marker", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    const upserts = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const writeId = upserts.find((o) => o.payload.draftId === "draft_x")?.payload.writeId
    await enqueueDraftResolve(workspaceId, "draft_x", 3)

    expect(await hasPendingDraftUpsert("draft_x")).toBe(true)
    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    const forDraft = resolves.filter((o) => o.payload.draftId === "draft_x")
    expect(forDraft).toHaveLength(1)
    expect(forDraft[0]?.payload.expectedVersion).toBe(3)
    expect(forDraft[0]?.payload.supersededWriteIds).toEqual([writeId])
  })
})

describe("syncDraftResolution", () => {
  it("enqueues a CAS resolve for a confirmed draft (baseVersion > 0)", async () => {
    await syncDraftResolution(workspaceId, "draft_x", 4)

    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    expect(resolves.filter((o) => o.payload.draftId === "draft_x" && o.payload.expectedVersion === 4)).toHaveLength(1)
  })

  it("queues a cleanup delete for a never-confirmed draft in case its upsert is already in flight", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_x")
    await syncDraftResolution(workspaceId, "draft_x", 0)

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    expect(await db.pendingOperations.where("type").equals("resolve_draft").count()).toBe(0)
    const deletes = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(deletes.filter((op) => op.payload.draftId === "draft_x")).toHaveLength(1)
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

  it("pushes the op's carried write lineage (priorWriteIds) on the wire", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 2 }))
    const calls: UpsertDraftInput[] = []
    const upsert = vi.fn(async (_w: string, id: string, input: UpsertDraftInput): Promise<UpsertDraftResponse> => {
      calls.push(input)
      return { draft: wireDraft({ id, version: 3 }), split: false }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_b", service(upsert), ["write_a"])

    expect(calls[0]).toMatchObject({ writeId: "write_b", priorWriteIds: ["write_a"] })
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

  it("keeps keystrokes typed during the in-flight split push (id migration re-reads the live row)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("pushed") }))
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_x" })
    const upsert = vi.fn(async (_w: string, id: string): Promise<UpsertDraftResponse> => {
      // A debounced save commits newer content while the PUT is in flight.
      await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("pushed plus more") }))
      return { draft: wireDraft({ id: "draft_new", version: 1 }), split: true, originalId: id }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    // The migration must carry the LIVE row's content, not the stale pre-push
    // snapshot — otherwise the newer keystrokes vanish from IDB.
    expect((await db.drafts.get("draft_new"))?.contentJson).toEqual(makeDoc("pushed plus more"))
  })

  it("seeds the server-kept row (the other copy) as a stash entry on a split", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1, contentJson: makeDoc("mine") }))
    const upsert = vi.fn(
      async (_w: string, id: string): Promise<UpsertDraftResponse> => ({
        draft: wireDraft({ id: "draft_new", version: 1, contentJson: makeDoc("mine") }),
        split: true,
        originalId: id,
        keptDraft: wireDraft({ id: "draft_x", version: 3, contentJson: makeDoc("theirs") }),
      })
    )

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    // Our content moved to the new id; the other device's kept row seeds locally
    // (its socket echo was ignored while this device was dirty).
    expect((await db.drafts.get("draft_new"))?.contentJson).toEqual(makeDoc("mine"))
    const kept = await db.drafts.get("draft_x")
    expect(kept).toMatchObject({ baseVersion: 3, contentJson: makeDoc("theirs") })
    // Seeding never activates the composer.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })

  it("seeds a drifted kept row even while this push's own op row is still in the table (sent mid-push)", async () => {
    // In production the executing op is deleted by the QUEUE only after
    // executeDraftUpsert returns — it must not trip the seed's dirty guard.
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 2 }))
    await enqueueDraftUpsert(workspaceId, "draft_x") // the op being executed
    await enqueueDraftResolve(workspaceId, "draft_x", 3) // the send
    const upsert = vi.fn(async (_w: string, id: string): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      return {
        draft: wireDraft({ id: "draft_new", version: 1 }),
        split: true,
        originalId: id,
        // Strictly newer than the pending resolve (3) — genuine foreign drift.
        keptDraft: wireDraft({ id: "draft_x", version: 4, contentJson: makeDoc("their newer edits") }),
      }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    const kept = await db.drafts.get("draft_x")
    expect(kept).toMatchObject({ baseVersion: 4, contentJson: makeDoc("their newer edits") })
  })

  it("does not seed a kept row this device just resolved (send raced the split)", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 2 }))
    await enqueueDraftResolve(workspaceId, "draft_x", 3)
    const upsert = vi.fn(async (_w: string, id: string): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      return {
        draft: wireDraft({ id: "draft_new", version: 1 }),
        split: true,
        originalId: id,
        keptDraft: wireDraft({ id: "draft_x", version: 3 }),
      }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    // The kept row is at the version the pending resolve targets — re-seeding it
    // would resurrect the just-sent draft as a stash entry.
    expect(await db.drafts.get("draft_x")).toBeUndefined()
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

  it("CAS-resolves the ghost server row when the draft was sent mid-push", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 2 }))
    await enqueueDraftResolve(workspaceId, "draft_x", 2)
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      return { draft: wireDraft({ id: "draft_x", version: 3 }), split: false }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    expect(await db.drafts.get("draft_x")).toBeUndefined()
    expect(await db.pendingOperations.where("type").equals("delete_draft").count()).toBe(0)
    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    expect(resolves.filter((o) => o.payload.draftId === "draft_x" && o.payload.expectedVersion === 3)).toHaveLength(1)
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

  it("removes a split ghost locally when its socket echo won the race", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      await db.drafts.put(localDraft({ id: "draft_new", baseVersion: 1 }))
      return { draft: wireDraft({ id: "draft_new", version: 1 }), split: true, originalId: "draft_x" }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    expect(await db.drafts.get("draft_new")).toBeUndefined()
    const dels = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(dels.filter((o) => o.payload.draftId === "draft_new")).toHaveLength(1)
  })

  it("CAS-resolves a split ghost when the original was sent mid-push", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    await enqueueDraftResolve(workspaceId, "draft_x", 1)
    const upsert = vi.fn(async (): Promise<UpsertDraftResponse> => {
      await db.drafts.delete("draft_x")
      await db.drafts.put(localDraft({ id: "draft_new", baseVersion: 1 }))
      return { draft: wireDraft({ id: "draft_new", version: 1 }), split: true, originalId: "draft_x" }
    })

    await executeDraftUpsert(workspaceId, "draft_x", "write_a", service(upsert))

    expect(await db.drafts.get("draft_new")).toBeUndefined()
    expect(await db.pendingOperations.where("type").equals("delete_draft").count()).toBe(0)
    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    expect(resolves.filter((o) => o.payload.draftId === "draft_new" && o.payload.expectedVersion === 1)).toHaveLength(1)
  })
})

describe("executeDraftDelete", () => {
  it("delegates to the service, carrying the superseded write lineage for the tombstone", async () => {
    const del = vi.fn(async () => {})
    await executeDraftDelete(workspaceId, "draft_x", { upsert: vi.fn(), delete: del } as unknown as DraftsServiceLike, [
      "write_inflight",
    ])
    expect(del).toHaveBeenCalledWith(workspaceId, "draft_x", { supersededWriteIds: ["write_inflight"] })
  })
})

describe("executeDraftResolve", () => {
  it("delegates a CAS resolve carrying expectedVersion to the service", async () => {
    const resolve = vi.fn(async () => ({ resolved: true }))
    await executeDraftResolve(
      workspaceId,
      "draft_x",
      5,
      {
        upsert: vi.fn(),
        resolve,
        delete: vi.fn(),
      } as unknown as DraftsServiceLike,
      ["write_sent"]
    )
    expect(resolve).toHaveBeenCalledWith(workspaceId, "draft_x", {
      expectedVersion: 5,
      supersededWriteIds: ["write_sent"],
    })
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

describe("resolve-on-send is authoritative against inbound echoes (no resurrection)", () => {
  it("applyDraftUpserted drops an echo of a draft this device just resolved", async () => {
    // Sent the message → resolved draft_server1 at version 1. The echo of our own
    // last push (or a reconnect re-seed of the still-present server row) arrives
    // before the resolve op drains — it must NOT be re-created.
    markDraftResolved("draft_server1", 1)

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft({ version: 1 }) }, workspaceId)

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("applyDraftsBootstrap (reconnect) does not resurrect a just-resolved draft", async () => {
    markDraftResolved("draft_server1", 1)

    await applyDraftsBootstrap(workspaceId, [wireDraft({ version: 1 })])

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("applyDraftUpserted drops an echo when the persisted resolve op is still queued", async () => {
    // Same scenario after a reload/resume: the in-memory tombstone is gone, but
    // the durable resolve_draft op remains. The server row still exists until the
    // queue drains, and must not be re-seeded as a sent-message draft.
    await enqueueDraftResolve(workspaceId, "draft_server1", 1)

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft({ version: 1 }) }, workspaceId)

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("applyDraftsBootstrap does not resurrect a draft whose resolve is still queued", async () => {
    await enqueueDraftResolve(workspaceId, "draft_server1", 1)

    await applyDraftsBootstrap(workspaceId, [wireDraft({ version: 1 })])

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("still applies a STRICTLY NEWER version from another device (no-loss)", async () => {
    // A genuine edit elsewhere bumped the version past what we resolved at — that
    // is real new work and survives (as a stash entry), never silently dropped.
    markDraftResolved("draft_server1", 1)

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft({ version: 2 }) }, workspaceId)

    expect(await db.drafts.get("draft_server1")).toBeDefined()
  })

  it("still applies a strictly newer version when a persisted resolve is queued", async () => {
    await enqueueDraftResolve(workspaceId, "draft_server1", 1)

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft({ version: 2 }) }, workspaceId)

    expect((await db.drafts.get("draft_server1"))?.baseVersion).toBe(2)
  })

  it("does not apply a newer echo while this device still has the sent upsert in flight", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_server1")
    await enqueueDraftResolve(workspaceId, "draft_server1", 1)

    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft({ version: 2 }) }, workspaceId)

    expect(await db.drafts.get("draft_server1")).toBeUndefined()
  })

  it("CAS-resolves a split echo whose write id belongs to a sent draft", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_server1")
    const upserts = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const writeId = upserts.find((o) => o.payload.draftId === "draft_server1")?.payload.writeId as string
    await enqueueDraftResolve(workspaceId, "draft_server1", 1)

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_split", version: 1, lastClientWriteId: writeId }),
      },
      workspaceId
    )

    expect(await db.drafts.get("draft_split")).toBeUndefined()
    const resolves = await db.pendingOperations.where("type").equals("resolve_draft").toArray()
    expect(
      resolves.filter((op) => op.payload.draftId === "draft_split" && op.payload.expectedVersion === 1)
    ).toHaveLength(1)
  })

  it("deletes a split echo whose write id belongs to a DISCARDED draft (no stash zombie)", async () => {
    // The user discarded the draft while its push was in flight; the push split
    // server-side and its echo arrives under a fresh id carrying our writeId.
    // That's the discarded body — remove it, don't stash it.
    await enqueueDraftUpsert(workspaceId, "draft_server1")
    const upserts = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const writeId = upserts.find((o) => o.payload.draftId === "draft_server1")?.payload.writeId as string
    await enqueueDraftDelete(workspaceId, "draft_server1") // collects the lineage

    await applyDraftUpserted(
      {
        workspaceId,
        targetUserId: userId,
        draft: wireDraft({ id: "draft_split", version: 1, lastClientWriteId: writeId }),
      },
      workspaceId
    )

    expect(await db.drafts.get("draft_split")).toBeUndefined()
    const deletes = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(deletes.filter((op) => op.payload.draftId === "draft_split")).toHaveLength(1)
  })

  it("bootstrap does not resurrect a split row from a discarded draft's lineage", async () => {
    await enqueueDraftUpsert(workspaceId, "draft_server1")
    const upserts = await db.pendingOperations.where("type").equals("upsert_draft").toArray()
    const writeId = upserts.find((o) => o.payload.draftId === "draft_server1")?.payload.writeId as string
    await enqueueDraftDelete(workspaceId, "draft_server1")

    await applyDraftsBootstrap(workspaceId, [wireDraft({ id: "draft_split", version: 1, lastClientWriteId: writeId })])

    expect(await db.drafts.get("draft_split")).toBeUndefined()
  })
})

describe("inbound sync never activates the composer (loaded pointer is local-only)", () => {
  it("applyDraftUpserted writes the row but never the composer-loaded pointer", async () => {
    await applyDraftUpserted({ workspaceId, targetUserId: userId, draft: wireDraft() }, workspaceId)

    expect(await db.drafts.get("draft_server1")).toBeDefined()
    // A roamed/echoed draft lands in the stash pile, never checked into a composer.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })

  it("applyDraftsBootstrap writes rows but never a composer-loaded pointer", async () => {
    await applyDraftsBootstrap(workspaceId, [wireDraft(), wireDraft({ id: "draft_server2" })])

    expect(await db.drafts.get("draft_server1")).toBeDefined()
    expect(await db.drafts.get("draft_server2")).toBeDefined()
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
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

  it("queues an idempotent server delete for a never-confirmed draft to clean up in-flight upsert ghosts", async () => {
    await db.drafts.put(localDraft({ id: "draft_x" })) // never confirmed → no baseVersion
    await enqueueDraftUpsert(workspaceId, "draft_x")

    await deleteDraftById(workspaceId, "draft_x")

    expect(await hasPendingDraftUpsert("draft_x")).toBe(false)
    const deletes = await db.pendingOperations.where("type").equals("delete_draft").toArray()
    expect(deletes.filter((op) => op.payload.draftId === "draft_x")).toHaveLength(1)
  })

  it("no-ops on an already-gone row", async () => {
    await deleteDraftById(workspaceId, "draft_missing")

    expect(await db.pendingOperations.where("type").equals("delete_draft").toArray()).toHaveLength(0)
  })
})

describe("cache signals defer to the surrounding transaction (no cache/IDB divergence on abort)", () => {
  it("drops the cache update when the outer transaction aborts after an id migration", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    await seedDraftCacheFromIdb(workspaceId)
    const migrateInCache = vi.spyOn(draftStore, "migrateLoadedDraftInCache")

    await expect(
      db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
        await migrateLocalDraftId(workspaceId, "draft_x", localDraft({ id: "draft_new", baseVersion: 0 }))
        throw new Error("abort")
      })
    ).rejects.toThrow("abort")

    // IDB rolled back — the cache must not have been told about the migration,
    // or it would render a draft id that no longer exists.
    expect(await db.drafts.get("draft_x")).toBeDefined()
    expect(await db.drafts.get("draft_new")).toBeUndefined()
    expect(migrateInCache).not.toHaveBeenCalled()
    migrateInCache.mockRestore()
  })

  it("emits the cache update only after the outer transaction commits", async () => {
    await db.drafts.put(localDraft({ id: "draft_x", baseVersion: 1 }))
    await seedDraftCacheFromIdb(workspaceId)
    const migrateInCache = vi.spyOn(draftStore, "migrateLoadedDraftInCache")

    await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
      await migrateLocalDraftId(workspaceId, "draft_x", localDraft({ id: "draft_new", baseVersion: 0 }))
      // Not yet — the write isn't durable until the outer transaction commits.
      expect(migrateInCache).not.toHaveBeenCalled()
    })

    await vi.waitFor(() => expect(migrateInCache).toHaveBeenCalledTimes(1))
    expect(await db.drafts.get("draft_new")).toBeDefined()
    migrateInCache.mockRestore()
  })
})

describe("reconcileStagedDrafts", () => {
  const loadedScope = "stream:stream_recover"

  async function setLoaded(row: CachedDraft) {
    await db.drafts.put(row)
    await db.composerLoaded.put({ scope: row.scope, workspaceId, draftId: row.id })
  }

  it("recovers an un-flushed tail (staged differs from the loaded IDB draft)", async () => {
    await setLoaded(
      localDraft({
        id: "draft_recover1",
        scope: loadedScope,
        contentJson: makeDoc("hello"),
        baseVersion: 4,
        attachments: [{ id: "att_1", filename: "f.txt", mimeType: "text/plain", sizeBytes: 1 }],
      })
    )
    stageDraftContent(workspaceId, loadedScope, makeDoc("hello world"))

    await reconcileStagedDrafts(workspaceId)

    const recovered = await db.drafts.get("draft_recover1")
    expect(recovered?.contentJson).toEqual(makeDoc("hello world"))
    // Sync bookkeeping + attachments survive a body-only recovery.
    expect(recovered?.baseVersion).toBe(4)
    expect(recovered?.attachments).toHaveLength(1)
    // Mirrored to the backend so cross-device drift splits on bootstrap.
    expect(await hasPendingDraftUpsert("draft_recover1")).toBe(true)
    // Buffer consumed.
    expect(readStagedDraft(workspaceId, loadedScope)).toBeNull()
  })

  it("drops a staged entry already captured by the last flush (no redundant push)", async () => {
    await setLoaded(
      localDraft({ id: "draft_recover2", scope: loadedScope, contentJson: makeDoc("same"), baseVersion: 2 })
    )
    stageDraftContent(workspaceId, loadedScope, makeDoc("same"))

    await reconcileStagedDrafts(workspaceId)

    expect(await hasPendingDraftUpsert("draft_recover2")).toBe(false)
    expect(readStagedDraft(workspaceId, loadedScope)).toBeNull()
  })

  it("creates a draft + loaded pointer when the scope has none", async () => {
    stageDraftContent(workspaceId, loadedScope, makeDoc("brand new"))

    await reconcileStagedDrafts(workspaceId)

    const pointer = await db.composerLoaded.get(loadedScope)
    expect(pointer?.draftId).toBeTruthy()
    const created = pointer?.draftId ? await db.drafts.get(pointer.draftId) : undefined
    expect(created?.contentJson).toEqual(makeDoc("brand new"))
    expect(created?.baseVersion).toBeUndefined()
    expect(await hasPendingDraftUpsert(pointer!.draftId!)).toBe(true)
  })

  it("never applies plaintext over a sealed (E2E) loaded draft (E2EE-4)", async () => {
    await setLoaded(
      localDraft({
        id: "draft_sealed",
        scope: loadedScope,
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        ciphertext: "sealed-bytes",
        envelope: { v: 1 },
        e2eVersion: 1,
        baseVersion: 1,
      })
    )
    stageDraftContent(workspaceId, loadedScope, makeDoc("plaintext leak"))

    await reconcileStagedDrafts(workspaceId)

    const row = await db.drafts.get("draft_sealed")
    expect(row?.ciphertext).toBe("sealed-bytes")
    expect(row?.contentJson).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
    expect(await hasPendingDraftUpsert("draft_sealed")).toBe(false)
    // Stale/foreign buffer is still cleared.
    expect(readStagedDraft(workspaceId, loadedScope)).toBeNull()
  })

  it("keeps the staged buffer when the recovery write fails (no loss, retried next load)", async () => {
    stageDraftContent(workspaceId, loadedScope, makeDoc("unflushed tail"))
    const putSpy = vi.spyOn(db.drafts, "put").mockRejectedValueOnce(new Error("idb boom"))

    await reconcileStagedDrafts(workspaceId)

    // The buffer is the only copy of the tail — it must survive a transient write
    // failure so the next load can retry, rather than being cleared away.
    expect(readStagedDraft(workspaceId, loadedScope)?.contentJson).toEqual(makeDoc("unflushed tail"))
    putSpy.mockRestore()
  })

  it("clears a staged entry whose content is empty without creating a draft", async () => {
    // Write an empty-content buffer directly (the public stage helper refuses to).
    localStorage.setItem(
      `threa:draft-stage:${workspaceId}:${loadedScope}`,
      JSON.stringify({ contentJson: { type: "doc", content: [{ type: "paragraph" }] }, clientUpdatedAt: Date.now() })
    )

    await reconcileStagedDrafts(workspaceId)

    expect(await db.composerLoaded.get(loadedScope)).toBeUndefined()
    expect(readStagedDraft(workspaceId, loadedScope)).toBeNull()
  })
})
