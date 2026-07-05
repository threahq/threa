import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { HttpError } from "../../lib/errors"
import * as dbModule from "../../db"
import { StreamBriefRepository, type StreamBrief } from "./brief-repository"
import { StreamBriefService, STREAM_BRIEF_MAX_CHARS, resolveBriefStreamId } from "./brief-service"

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

describe("StreamBriefService.update", () => {
  afterEach(() => mock.restore())

  it("creates the brief at version 1 when expectedVersion is 0, with a revision row in the same transaction", async () => {
    stubTransaction()
    const insertFirst = spyOn(StreamBriefRepository, "insertFirstVersion").mockResolvedValue(fakeBrief())
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().update({
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
    const updated = fakeBrief({ version: 4, content: "Goal: ship v3", updatedByKind: "persona" })
    const updateAtVersion = spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(updated)
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().update({
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

  it("reports version_conflict with the fresh row when the guard misses, and writes no revision", async () => {
    stubTransaction()
    const current = fakeBrief({ version: 5 })
    spyOn(StreamBriefRepository, "updateAtVersion").mockResolvedValue(null)
    spyOn(StreamBriefRepository, "findByStreamId").mockResolvedValue(current)
    const insertRevision = spyOn(StreamBriefRepository, "insertRevision").mockResolvedValue(undefined)

    const result = await makeService().update({
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

    const result = await makeService().update({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "late create",
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(result).toEqual({ outcome: "version_conflict", current })
  })

  it("rejects content over the cap before touching the database", async () => {
    const withTransaction = spyOn(dbModule, "withTransaction")

    const attempt = makeService().update({
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "x".repeat(STREAM_BRIEF_MAX_CHARS + 1),
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    await expect(attempt).rejects.toMatchObject({ status: 400, code: "BRIEF_TOO_LONG" })
    await expect(attempt).rejects.toBeInstanceOf(HttpError)
    expect(withTransaction).not.toHaveBeenCalled()
  })
})

describe("resolveBriefStreamId", () => {
  it("keys a thread's brief on its root stream (INV-62 thread → root), a top-level stream on itself", () => {
    expect(resolveBriefStreamId({ id: "stream_thread", rootStreamId: "stream_root" })).toBe("stream_root")
    expect(resolveBriefStreamId({ id: "stream_chan", rootStreamId: null })).toBe("stream_chan")
  })
})
