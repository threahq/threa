import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { DraftsService } from "../../src/features/drafts/service"
import { DraftsRepository } from "../../src/features/drafts/repository"
import { userId, workspaceId, draftId } from "../../src/lib/id"
import type { JSONContent } from "@threahq/types"

// INV-68: `stashed_at` is verified against the real schema — the column exists,
// the insert and CAS-update statements actually run, and the value round-trips
// through the repository (µs-precision TIMESTAMPTZ vs JS ms is exactly the class
// of drift a text assertion can't see).
describe("drafts.stashed_at round-trip", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let service: DraftsService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Test Workspace",
        slug: `test-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
    })
    service = new DraftsService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  type ServiceUpsertParams = Parameters<DraftsService["upsert"]>[0]

  function upsertParams(id: string, overrides: Partial<ServiceUpsertParams> = {}): ServiceUpsertParams {
    return {
      workspaceId: testWorkspaceId,
      userId: testUserId,
      id,
      scope: "stream:stream_it",
      rootStreamId: null,
      expectedVersion: 0,
      writeId: `write_${id}_1`,
      priorWriteIds: [],
      clientUpdatedAt: new Date("2026-08-06T10:00:00.000Z"),
      stashedAt: null,
      contentJson: { type: "doc", content: [] } as JSONContent,
      contentMarkdown: "body",
      attachmentIds: [],
      command: null,
      contextRefs: null,
      ciphertext: null,
      envelope: null,
      e2eVersion: null,
      ...overrides,
    }
  }

  test("insert persists stashed_at and the view reads it back", async () => {
    const id = draftId()
    const stashedAt = new Date("2026-08-06T11:22:33.000Z")
    const created = await service.upsert(upsertParams(id, { stashedAt }))

    expect(created.split).toBe(false)
    expect(created.draft.stashedAt).toBe(stashedAt.toISOString())

    const row = await DraftsRepository.findByIdForUpdate(pool, testWorkspaceId, testUserId, id)
    expect(row?.stashedAt?.toISOString()).toBe(stashedAt.toISOString())
  })

  test("CAS update sets and clears stashed_at in place", async () => {
    const id = draftId()
    const created = await service.upsert(upsertParams(id))
    expect(created.draft.stashedAt).toBeNull()

    const stashedAt = new Date("2026-08-06T12:00:00.000Z")
    const stashed = await service.upsert(
      upsertParams(id, { stashedAt, expectedVersion: created.draft.version, writeId: `write_${id}_2` })
    )
    expect(stashed.split).toBe(false)
    expect(stashed.draft.stashedAt).toBe(stashedAt.toISOString())

    const restored = await service.upsert(
      upsertParams(id, { stashedAt: null, expectedVersion: stashed.draft.version, writeId: `write_${id}_3` })
    )
    expect(restored.split).toBe(false)
    expect(restored.draft.stashedAt).toBeNull()
  })

  test("an ABSENT stashedAt preserves the row's current value — a legacy client's autosave cannot erase a stash", async () => {
    const id = draftId()
    const created = await service.upsert(upsertParams(id))
    const stashedAt = new Date("2026-08-06T14:00:00.000Z")
    const stashed = await service.upsert(
      upsertParams(id, { stashedAt, expectedVersion: created.draft.version, writeId: `write_${id}_2` })
    )
    expect(stashed.draft.stashedAt).toBe(stashedAt.toISOString())

    // The old-bundle client: no stashedAt field at all on its push.
    const legacy = await service.upsert(
      upsertParams(id, { stashedAt: undefined, expectedVersion: stashed.draft.version, writeId: `write_${id}_3` })
    )
    expect(legacy.split).toBe(false)
    expect(legacy.draft.stashedAt).toBe(stashedAt.toISOString())
  })

  test("a version-mismatch split carries the INCOMING stashedAt onto the fresh row", async () => {
    const id = draftId()
    const created = await service.upsert(upsertParams(id))

    const stashedAt = new Date("2026-08-06T13:00:00.000Z")
    // Wrong expectedVersion + a foreign write lineage → genuine drift → split.
    const split = await service.upsert(
      upsertParams(id, {
        stashedAt,
        expectedVersion: created.draft.version + 5,
        writeId: `write_${id}_other`,
      })
    )

    expect(split.split).toBe(true)
    expect(split.draft.id).not.toBe(id)
    expect(split.draft.stashedAt).toBe(stashedAt.toISOString())
    // The untouched original keeps its own (null) flag.
    const original = await DraftsRepository.findByIdForUpdate(pool, testWorkspaceId, testUserId, id)
    expect(original?.stashedAt).toBeNull()
  })
})
