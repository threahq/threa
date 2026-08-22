/**
 * Aside draft scopes (PR6) against the real schema (INV-68): the scope is
 * opaque to the server, so `aside:{asideId}:{draftId}` stores, lists and
 * CAS-updates exactly like any other draft (INV-66) — the privacy of an aside's
 * drafts is a client-side rule, not a second server path.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { DraftsService } from "../../src/features/drafts/service"
import { DraftsRepository } from "../../src/features/drafts/repository"
import { userId, workspaceId, draftId } from "../../src/lib/id"
import type { JSONContent } from "@threa/types"

describe("aside draft scopes", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let service: DraftsService

  const ASIDE_SCOPE = "aside:stream_01ASIDE:draft_01ONE"

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Aside Draft Workspace",
        slug: `aside-draft-ws-${testWorkspaceId}`,
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
      scope: ASIDE_SCOPE,
      rootStreamId: null,
      expectedVersion: 0,
      writeId: `write_${id}_1`,
      priorWriteIds: [],
      clientUpdatedAt: new Date("2026-08-22T10:00:00.000Z"),
      stashedAt: null,
      contentJson: { type: "doc", content: [{ type: "paragraph" }] } as JSONContent,
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

  test("stores an aside-scoped draft and reads the scope back verbatim", async () => {
    const id = draftId()
    const created = await service.upsert(upsertParams(id))

    expect({ split: created.split, scope: created.draft.scope, version: created.draft.version }).toEqual({
      split: false,
      scope: ASIDE_SCOPE,
      version: 1,
    })

    const row = await DraftsRepository.findByIdForUpdate(pool, testWorkspaceId, testUserId, id)
    expect(row?.scope).toBe(ASIDE_SCOPE)
  })

  test("CAS-guards an aside draft like any other: a stale base version splits instead of clobbering", async () => {
    const id = draftId()
    const created = await service.upsert(upsertParams(id))

    const updated = await service.upsert(
      upsertParams(id, {
        expectedVersion: created.draft.version,
        writeId: `write_${id}_2`,
        contentMarkdown: "second pass",
      })
    )
    expect({ split: updated.split, version: updated.draft.version, body: updated.draft.contentMarkdown }).toEqual({
      split: false,
      version: 2,
      body: "second pass",
    })

    // A device that never saw version 2 pushes against version 1.
    const stale = await service.upsert(
      upsertParams(id, {
        expectedVersion: created.draft.version,
        writeId: `write_${id}_3`,
        contentMarkdown: "from the other device",
      })
    )
    expect(stale.split).toBe(true)
    expect(stale.draft.id).not.toBe(id)

    const original = await DraftsRepository.findByIdForUpdate(pool, testWorkspaceId, testUserId, id)
    expect(original?.contentMarkdown).toBe("second pass")
  })
})
