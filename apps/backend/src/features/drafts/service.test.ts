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

  it("returns the existing row unchanged on a lost-ack retry (matching writeId), no split, no CAS", async () => {
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

  it("SPLITS on version drift: keeps the original id, mints a fresh draft, returns originalId", async () => {
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    // First call (original id) collides → null; second call (fresh split id) lands.
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(fakeDraft({ version: 5 }))
    spyOn(DraftsRepository, "casUpdate").mockResolvedValue(null) // version drift
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_drift", expectedVersion: 2 })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
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

  it("does NOT return a tombstoned row as live on a writeId match — splits instead", async () => {
    // A resolve raced in after the original write landed: the writeId still
    // matches, but the row is soft-deleted. Branch (b) must not hand it back as
    // live (that would contradict the draft:deleted already on the wire); it
    // falls through to the split.
    const service = setupService()
    const splitRow = fakeDraft({ id: "draft_split", version: 1 })
    spyOn(DraftsRepository, "insertIfAbsent").mockResolvedValueOnce(null).mockResolvedValueOnce(splitRow)
    spyOn(DraftsRepository, "findByIdForUpdate").mockResolvedValue(
      fakeDraft({ version: 2, lastClientWriteId: "write_dup", deletedAt: NOW })
    )
    const casUpdate = spyOn(DraftsRepository, "casUpdate")
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.upsert({ ...baseUpsertParams(), writeId: "write_dup", expectedVersion: 2 })

    expect(result.split).toBe(true)
    expect(result.originalId).toBe(DRAFT_ID)
    expect(result.draft.id).toBe("draft_split")
    // A tombstoned row skips the CAS update entirely (branch (c) is live-gated).
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
    spyOn(DraftsRepository, "softDelete").mockResolvedValue(fakeDraft({ deletedAt: NOW }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.delete({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: DRAFT_ID })

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
