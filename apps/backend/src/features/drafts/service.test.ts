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

  it("applies a lost-ack retry in place through the write-lineage CAS (no split, content not discarded)", async () => {
    // The row's last accepted write is the incoming writeId (our own push whose
    // ack was lost). The retry may carry NEWER content (the queue re-reads at
    // drain), so it must flow through the CAS update — keyed on the lineage,
    // not the stale expectedVersion — rather than being acked-and-discarded.
    const service = setupService()
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 4, lastClientWriteId: "write_retry" })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate").mockResolvedValue(
      fakeDraft({ version: 5, lastClientWriteId: "write_retry" })
    )
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_retry", expectedVersion: 3 })

    expect(result.split).toBe(false)
    expect(result.draft.version).toBe(5)
    expect(casUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedVersion: 3, ownWriteIds: ["write_retry"] })
    )
    expect(outbox).toHaveBeenCalledWith(expect.anything(), "draft:upserted", expect.objectContaining({}))
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
      expect.objectContaining({ ownWriteIds: ["write_next", "write_prior"] })
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

  it("drops a fresh insert landing on a tombstone without splitting", async () => {
    const service = setupService()
    const insertIfAbsent = spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValue(null)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 1, lastClientWriteId: null, deletedAt: NOW })
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

  it("declines on version drift — the drifted copy survives and nothing is published", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "softDeleteCas").mockResolvedValue(null)
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.resolve({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: DRAFT_ID,
      expectedVersion: 1,
    })

    expect(result.resolved).toBe(false)
    expect(outbox).not.toHaveBeenCalled()
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

  it("does not publish when the row was already tombstoned", async () => {
    const service = setupService()
    spyOn(DraftsRepository, "softDelete").mockResolvedValue(null)
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.delete({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: DRAFT_ID })

    expect(outbox).not.toHaveBeenCalled()
  })
})
