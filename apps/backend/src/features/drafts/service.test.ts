import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { DraftsService } from "./service"
import { DraftsRepository, type Draft } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const DRAFT_ID = "draft_01"
const NOW = new Date("2026-06-13T12:00:00.000Z")

function fakeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: DRAFT_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    scope: "stream:stream_1",
    rootStreamId: "stream_1",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    attachmentIds: [],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    version: 1,
    lastClientWriteId: "write_1",
    supersededWriteIds: null,
    clientUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  }
}

function baseUpsertParams() {
  return {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    id: DRAFT_ID,
    scope: "stream:stream_1",
    rootStreamId: "stream_1" as string | null,
    expectedVersion: 0,
    writeId: "write_1",
    priorWriteIds: [] as string[],
    clientUpdatedAt: NOW,
    contentJson: { type: "doc" as const, content: [] },
    contentMarkdown: "hello",
    attachmentIds: [] as string[],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}

function setupService() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new DraftsService({ pool: {} as any })
}

describe("DraftsService.upsert", () => {
  afterEach(() => mock.restore())

  it("inserts a brand-new draft and publishes draft:upserted without splitting", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(fakeDraft())
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert(baseUpsertParams())

    expect(result.split).toBe(false)
    expect(result.originalId).toBeUndefined()
    expect(result.draft.id).toBe(DRAFT_ID)
    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "draft:upserted",
      expect.objectContaining({ targetUserId: USER_ID, workspaceId: WORKSPACE_ID })
    )
  })

  it("returns the row unchanged on an EXACT lost-ack retry (same writeId) — true idempotency, no version churn", async () => {
    // An exact writeId match implies identical content: a retry reuses its op's
    // writeId, and any typing since the attempt replaces the op with a fresh
    // one. So the accepted write can be acked as-is — no re-apply, no bump, no
    // redundant outbox echo.
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 4, lastClientWriteId: "write_retry" })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate")
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_retry", expectedVersion: 3 })

    expect(result.split).toBe(false)
    expect(result.draft.version).toBe(4)
    expect(casUpdate).not.toHaveBeenCalled()
    expect(outbox).not.toHaveBeenCalled()
  })

  it("passes the full write lineage (writeId + priorWriteIds) into the CAS", async () => {
    // A coalesced save replaced an attempted push: the successor carries the
    // superseded writeId so a lost ack of the predecessor still updates in
    // place instead of splitting into a same-device duplicate.
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 4, lastClientWriteId: "write_prior" })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate").mockResolvedValue(fakeDraft({ version: 5 }))
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({
      ...baseUpsertParams(),
      writeId: "write_next",
      priorWriteIds: ["write_prior"],
      expectedVersion: 3,
    })

    expect(result.split).toBe(false)
    expect(casUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "stream:stream_1", ownWriteIds: ["write_next", "write_prior"] })
    )
  })

  it("CAS-updates on a version match (happy path) without splitting", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(fakeDraft({ version: 2 }))
    spyOn(DraftsRepository, "casUpdate").mockResolvedValue(fakeDraft({ version: 3 }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_new", expectedVersion: 2 })

    expect(result.split).toBe(false)
    expect(result.draft.version).toBe(3)
    expect(outbox).toHaveBeenCalledWith(expect.anything(), "draft:upserted", expect.objectContaining({}))
  })

  it("SPLITS on genuine drift: keeps the original id, mints a fresh draft, returns originalId + keptDraft", async () => {
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    // First call (original id) collides → null; second call (fresh split id) lands.
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 5, lastClientWriteId: "write_other_device" })
    )
    spyOn(DraftsRepository, "casUpdate").mockResolvedValue(null) // version drift, foreign lineage
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_drift", expectedVersion: 2 })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
    // The untouched live row rides back so the pushing device (which ignored
    // its echo while dirty) can seed the other copy without waiting for a
    // bootstrap.
    expect(result.keptDraft).toMatchObject({ id: DRAFT_ID, version: 5 })
  })

  it("drops a late first insert whose lineage the negative tombstone superseded (discard raced the insert)", async () => {
    // The discard's `enqueueDraftDelete` collected the pending push's writeId
    // into the tombstone, so the late insert is provably discarded content.
    const service = setupService()
    const insertIfAbsent = spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 1, lastClientWriteId: null, supersededWriteIds: ["write_late"], deletedAt: NOW })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate")
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_late", expectedVersion: 0 })

    expect(result.split).toBe(false)
    expect(result.originalId).toBeUndefined()
    expect(result.draft.id).toBe(DRAFT_ID)
    expect(insertIfAbsent).toHaveBeenCalledTimes(1)
    expect(casUpdate).not.toHaveBeenCalled()
    expect(outbox).not.toHaveBeenCalled()
  })

  it("SPLITS a version-0 push onto a tombstone with no lineage evidence (no-loss default)", async () => {
    // Without an exact-retry or persisted-lineage match the tombstone cannot
    // prove the content was sent or discarded — dropping it here was the old
    // behavior and could destroy a tail typed after a lost first ack.
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 2, lastClientWriteId: "write_other", supersededWriteIds: null, deletedAt: NOW })
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_late", expectedVersion: 0 })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
  })

  it("SPLITS when only a PRIOR write id matches the tombstone's last accepted write (unsent tail survives)", async () => {
    // Device A: push W1 lands, ack lost; A types a tail offline (op replaced,
    // priors [W1]). Device B sends the draft (version CAS, empty superseded
    // list) — the tombstone's last accepted write is W1, but B's send contained
    // only W1's content. A's push carries the tail B never saw: a prefix-only
    // lineage match must NOT drop it. Split preserves the tail as a new draft.
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 3, lastClientWriteId: "write_1", supersededWriteIds: [], deletedAt: NOW })
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({
      ...baseUpsertParams(),
      writeId: "write_2",
      priorWriteIds: ["write_1"],
      expectedVersion: 1,
    })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
  })

  it("drops a lost-ack retry landing on its own tombstone (resolve raced the write) — no zombie split", async () => {
    // The write landed, then resolve-on-send tombstoned the row. The retry of
    // that same write is content the user already SENT: it must be dropped, not
    // split into a live duplicate of the sent message.
    const service = setupService()
    const insertIfAbsent = spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 3, lastClientWriteId: "write_dup", deletedAt: NOW })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate")
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_dup", expectedVersion: 2 })

    expect(result.split).toBe(false)
    expect(result.originalId).toBeUndefined()
    expect(insertIfAbsent).toHaveBeenCalledTimes(1)
    expect(casUpdate).not.toHaveBeenCalled()
    expect(outbox).not.toHaveBeenCalled()
  })

  it("drops a late write whose lineage the tombstone superseded (persisted at resolve/discard time)", async () => {
    // The push left the device, the client gave up on it, resolve tombstoned
    // the row recording the in-flight writeId — then the push finally lands.
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({
        version: 3,
        lastClientWriteId: "write_old",
        supersededWriteIds: ["write_inflight"],
        deletedAt: NOW,
      })
    )
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_inflight", expectedVersion: 2 })

    expect(result.split).toBe(false)
    expect(outbox).not.toHaveBeenCalled()
  })

  it("still SPLITS on a tombstone for a foreign write lineage (no-loss for another device's edits)", async () => {
    // The draft was resolved/discarded elsewhere while THIS push carries edits
    // the tombstone knows nothing about — they must survive as a fresh draft.
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({
        version: 3,
        lastClientWriteId: "write_other",
        supersededWriteIds: ["write_other_inflight"],
        deletedAt: NOW,
      })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate")
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_mine", expectedVersion: 2 })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
    // A tombstoned original is not returned as keptDraft (it is not live).
    expect(result.keptDraft).toBeUndefined()
    // A tombstoned row skips the CAS update entirely (the CAS is live-gated).
    expect(casUpdate).not.toHaveBeenCalled()
  })
})

describe("DraftsService.resolve", () => {
  afterEach(() => mock.restore())

  it("soft-deletes on a version match and publishes draft:deleted", async () => {
    const service = setupService()
    const softDelete = spyOn(DraftsRepository, "softDeleteCas").mockResolvedValue(fakeDraft({ deletedAt: NOW }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.resolve({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: DRAFT_ID,
      expectedVersion: 1,
      supersededWriteIds: ["write_sent"],
    })

    expect(result.resolved).toBe(true)
    expect(softDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedVersion: 1, supersededWriteIds: ["write_sent"] })
    )
    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "draft:deleted",
      expect.objectContaining({ targetUserId: USER_ID, draftId: DRAFT_ID })
    )
  })

  it("declines on version drift — the drifted copy survives, nothing published, lineage still merged onto a tombstone", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "softDeleteCas").mockResolvedValue(null)
    const merge = spyOn(DraftsRepository, "mergeTombstoneSupersededWriteIds").mockResolvedValue()
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.resolve({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: DRAFT_ID,
      expectedVersion: 1,
      supersededWriteIds: ["write_sent"],
    })

    expect(result.resolved).toBe(false)
    expect(outbox).not.toHaveBeenCalled()
    // If the decline was "already tombstoned" (second resolver), this device's
    // lineage must still land on the tombstone so its late push can't zombie.
    // The merge no-ops on a live row, so calling it unconditionally is safe.
    expect(merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: DRAFT_ID, supersededWriteIds: ["write_sent"] })
    )
  })
})

describe("DraftsService.delete", () => {
  afterEach(() => mock.restore())

  it("publishes draft:deleted when softDelete tombstones or plants a negative marker", async () => {
    const service = setupService()
    const softDelete = spyOn(DraftsRepository, "softDelete").mockResolvedValue(fakeDraft({ deletedAt: NOW }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.delete({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: DRAFT_ID,
      supersededWriteIds: ["write_inflight"],
    })

    // The discarding device's in-flight write ids ride onto the tombstone so a
    // late-landing push of the discarded content is dropped, not resurrected.
    expect(softDelete).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, USER_ID, DRAFT_ID, ["write_inflight"])
    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "draft:deleted",
      expect.objectContaining({ targetUserId: USER_ID, draftId: DRAFT_ID })
    )
  })

  it("does not publish when already tombstoned, but merges this device's lineage onto the tombstone", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "softDelete").mockResolvedValue(null)
    const merge = spyOn(DraftsRepository, "mergeTombstoneSupersededWriteIds").mockResolvedValue()
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.delete({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: DRAFT_ID,
      supersededWriteIds: ["write_inflight"],
    })

    expect(outbox).not.toHaveBeenCalled()
    expect(merge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: DRAFT_ID, supersededWriteIds: ["write_inflight"] })
    )
  })
})
