import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { HttpError } from "../../lib/errors"
import * as dbModule from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "./event-repository"
import { StreamBriefRepository, type StreamBrief } from "./brief-repository"
import { StreamBriefService, STREAM_BRIEF_MAX_CHARS, resolveBriefStreamId } from "./brief-service"
import * as writeAuthority from "./write-authority"

function fakeBrief(overrides: Partial<StreamBrief> = {}): StreamBrief {
  return {
    id: "sbrf_01",
    workspaceId: "ws_1",
    streamId: "stream_1",
    content: "Goal: ship v2",
    version: 1,
    updatedByKind: "user",
    updatedById: "usr_1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-05T00:00:00Z"),
    ...overrides,
  }
}

function makeService() {
  return new StreamBriefService({ pool: {} as Pool })
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

/**
 * Stub the brief_updated timeline append (roadmap 4.2) so the accepted-write
 * tests don't need a real DB. Returns the insert spy so a test can assert the
 * event's presence + payload (INV-23: assert content, not counts).
 */
function stubEventAppend() {
  const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as any)
  spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
  return insertEvent
}

describe("StreamBriefService.update", () => {
  afterEach(() => mock.restore())

  for (const reason of ["archived", "system_stream", "not_member"] as const) {
    it(`denies generated ${reason} before brief/event writes`, async () => {
      stubTransaction()
      spyOn(writeAuthority, "assertStreamWritable").mockRejectedValue(
        new HttpError("Stream is read-only", { status: 403, code: "STREAM_READ_ONLY", details: { reason } })
      )
      const insertFirst = spyOn(StreamBriefRepository, "insertFirstVersion").mockResolvedValue(fakeBrief())
      const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)

      await expect(
        makeService().updateGenerated({
          workspaceId: "ws_1",
          streamId: "stream_1",
          requestedStreamId: "thread_1",
          principal: { kind: "user", userId: "usr_1" },
          content: "blocked",
          expectedVersion: 0,
          updatedByKind: "persona",
          updatedById: "persona_1",
        })
      ).rejects.toMatchObject({ code: "STREAM_READ_ONLY", details: { reason } })
      expect(insertFirst).not.toHaveBeenCalled()
      expect(insertEvent).not.toHaveBeenCalled()
    })
  }

  it("creates the brief at version 1 when expectedVersion is 0, with a revision row in the same transaction", async () => {
    stubTransaction()
    stubEventAppend()
    const insertFirst = spyOn(StreamBriefRepository, "insertFirstVersion").mockResolvedValue(fakeBrief())
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v2",
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(result).toEqual({ outcome: "updated", brief: fakeBrief() })
    expect(insertFirst).toHaveBeenCalled()
    expect(insertRevision.mock.calls.at(-1)?.[1]).toMatchObject({
      briefId: "sbrf_01",
      version: 1,
      content: "Goal: ship v2",
      updatedByKind: "user",
      updatedById: "usr_1",
    })
  })

  it("updates through the version guard when expectedVersion > 0 and records the new version's revision", async () => {
    stubTransaction()
    stubEventAppend()
    const updated = fakeBrief({ version: 4, content: "Goal: ship v3", updatedByKind: "persona" })
    const updateAtVersion = spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(updated)
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v3",
      expectedVersion: 3,
      updatedByKind: "persona",
      updatedById: "persona_ariadne",
    })

    expect(result).toEqual({ outcome: "updated", brief: updated })
    expect(updateAtVersion.mock.calls.at(-1)?.[1]).toMatchObject({ expectedVersion: 3 })
    expect(insertRevision.mock.calls.at(-1)?.[1]).toMatchObject({ version: 4, content: "Goal: ship v3" })
  })

  it("appends a brief_updated timeline event in the same transaction, attributed to the writer with the new version and reason (roadmap 4.2)", async () => {
    stubTransaction()
    const insertEvent = stubEventAppend()
    const updated = fakeBrief({ version: 4, content: "Goal: ship v3", updatedByKind: "persona", id: "sbrf_42" })
    spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(updated)
    spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_root",
      content: "Goal: ship v3",
      expectedVersion: 3,
      updatedByKind: "persona",
      updatedById: "persona_ariadne",
      reason: "recorded the weekly-ship decision",
    })

    expect(insertEvent.mock.calls.at(-1)?.[1]).toMatchObject({
      streamId: "stream_root",
      eventType: "brief_updated",
      actorId: "persona_ariadne",
      actorType: "persona",
      payload: { briefId: "sbrf_42", version: 4, reason: "recorded the weekly-ship decision" },
    })
  })

  it("carries a null reason on the brief_updated event when the writer supplies none (member editor path)", async () => {
    stubTransaction()
    const insertEvent = stubEventAppend()
    spyOn(StreamBriefRepository, "insertFirstVersion").mockResolvedValue(fakeBrief({ version: 1, id: "sbrf_1" }))
    spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v2",
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(insertEvent.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: "brief_updated",
      actorType: "user",
      payload: { briefId: "sbrf_1", version: 1, reason: null },
    })
  })

  it("does NOT append a brief_updated event when the write loses the version guard", async () => {
    stubTransaction()
    const insertEvent = stubEventAppend()
    spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(null)
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(fakeBrief({ version: 5 }))

    await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "stale write",
      expectedVersion: 3,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(insertEvent).not.toHaveBeenCalled()
  })

  it("reports version_conflict with the fresh row when the guard misses, and writes no revision", async () => {
    stubTransaction()
    const current = fakeBrief({ version: 5 })
    spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(null)
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(current)
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "stale write",
      expectedVersion: 3,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(result).toEqual({ outcome: "version_conflict", current })
    expect(insertRevision).not.toHaveBeenCalled()
  })

  it("reports version_conflict when a create (expectedVersion 0) loses to an existing brief", async () => {
    stubTransaction()
    const current = fakeBrief({ version: 2 })
    spyOn(StreamBriefRepository, "insertFirstVersion").mockResolvedValue(null)
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(current)

    const result = await makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "late create",
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(result).toEqual({ outcome: "version_conflict", current })
  })

  it("rejects generated content over the cap inside its transaction before writing", async () => {
    stubTransaction()
    const insertFirst = spyOn(StreamBriefRepository, "insertFirstVersion")

    const attempt = makeService().updateInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "x".repeat(STREAM_BRIEF_MAX_CHARS + 1),
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    await expect(attempt).rejects.toMatchObject({ status: 400, code: "BRIEF_TOO_LONG" })
    await expect(attempt).rejects.toBeInstanceOf(HttpError)
    expect(insertFirst).not.toHaveBeenCalled()
  })
})

describe("resolveBriefStreamId", () => {
  it("keys a thread's brief on its root stream (INV-62 thread → root), a top-level stream on itself", () => {
    expect(resolveBriefStreamId({ id: "stream_thread", rootStreamId: "stream_root" })).toBe("stream_root")
    expect(resolveBriefStreamId({ id: "stream_chan", rootStreamId: null })).toBe("stream_chan")
  })
})
