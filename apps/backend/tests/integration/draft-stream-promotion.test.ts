/**
 * Promoting a client draft to a scratchpad is idempotent per (owner, draft id)
 * and pulls the drafts composed under the unpromoted scope onto the real
 * stream, verified against the real schema (INV-68): the partial unique index
 * on `streams.uniqueness_key` absorbs the duplicate insert, and the set-based
 * scope re-point joins `drafts` to `streams` on the key the create wrote.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository } from "../../src/features/streams"
import { StreamMemberRepository } from "../../src/features/streams/member-repository"
import { DraftsService, DraftsRepository } from "../../src/features/drafts"
import { OutboxRepository } from "../../src/lib/outbox"
import { userId, workspaceId, draftId } from "../../src/lib/id"
import { draftStreamScope, type JSONContent } from "@threa/types"

describe("draft stream promotion", () => {
  let pool: Pool
  let streamService: StreamService
  let draftsService: DraftsService
  let wsId: string
  let owner: string
  let otherUser: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    draftsService = new DraftsService({ pool })
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      owner = (await addTestMember(client, wsId, userId())).id
      otherUser = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Draft Promotion Workspace",
        slug: `draft-promotion-${wsId.toLowerCase()}`,
        createdBy: owner,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function outboxBaseline(): Promise<bigint> {
    const baseline = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM outbox")
    return BigInt(baseline.rows[0].max_id)
  }

  function clientDraftId(): string {
    return `draft_${draftId().slice("draft_".length)}`
  }

  type ServiceUpsertParams = Parameters<DraftsService["upsert"]>[0]

  function upsertParams(
    user: string,
    scope: string,
    overrides: Partial<ServiceUpsertParams> = {}
  ): ServiceUpsertParams {
    const id = draftId()
    return {
      workspaceId: wsId,
      userId: user,
      id,
      scope,
      rootStreamId: null,
      expectedVersion: 0,
      writeId: `write_${id}_1`,
      priorWriteIds: [],
      clientUpdatedAt: new Date("2026-09-05T10:00:00.000Z"),
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

  test("concurrent creates for one draft id mint one scratchpad with one member and one stream:created", async () => {
    const clientDraft = clientDraftId()
    const baseline = await outboxBaseline()

    const [first, second] = await Promise.all([
      streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft }),
      streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft }),
    ])

    expect(second.id).toBe(first.id)
    const rows = await pool.query("SELECT id FROM streams WHERE workspace_id = $1 AND uniqueness_key = $2", [
      wsId,
      `draft:${owner}:${clientDraft}`,
    ])
    expect(rows.rows.map((row) => row.id)).toEqual([first.id])
    const members = await StreamMemberRepository.list(pool, { streamId: first.id })
    expect(members.map((member) => member.memberId)).toEqual([owner])
    const created = (await OutboxRepository.fetchAfterId(pool, baseline)).filter(
      (event) => event.eventType === "stream:created" && event.payload.streamId === first.id
    )
    expect(created).toHaveLength(1)
  })

  test("a retried create returns the existing scratchpad without a second stream:created", async () => {
    const clientDraft = clientDraftId()
    const first = await streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft })
    const baseline = await outboxBaseline()

    const retry = await streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft })

    expect(retry.id).toBe(first.id)
    expect(retry.type).toBe("scratchpad")
    const events = await OutboxRepository.fetchAfterId(pool, baseline)
    expect(events.map((event) => event.eventType)).not.toContain("stream:created")
  })

  test("the create re-points drafts under the draft scope onto the real stream and tells the owner's devices", async () => {
    const clientDraft = clientDraftId()
    const composed = await draftsService.upsert(upsertParams(owner, draftStreamScope(clientDraft)))
    const untouched = await draftsService.upsert(upsertParams(owner, draftStreamScope(clientDraftId())))
    const baseline = await outboxBaseline()

    const stream = await streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft })

    const row = await DraftsRepository.findByIdForUpdate(pool, wsId, owner, composed.draft.id)
    expect(row).toEqual(
      expect.objectContaining({
        scope: draftStreamScope(stream.id),
        rootStreamId: stream.id,
        version: composed.draft.version + 1,
      })
    )
    const untouchedRow = await DraftsRepository.findByIdForUpdate(pool, wsId, owner, untouched.draft.id)
    expect(untouchedRow).toEqual(
      expect.objectContaining({ scope: untouched.draft.scope, rootStreamId: null, version: untouched.draft.version })
    )
    const upserted = (await OutboxRepository.fetchAfterId(pool, baseline)).filter(
      (event) => event.eventType === "draft:upserted"
    )
    expect(upserted.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        workspaceId: wsId,
        targetUserId: owner,
        draft: expect.objectContaining({
          id: composed.draft.id,
          scope: draftStreamScope(stream.id),
          rootStreamId: stream.id,
        }),
      }),
    ])
  })

  test("the drafts bootstrap repairs a draft pushed under an already-promoted scope", async () => {
    const clientDraft = clientDraftId()
    const stream = await streamService.createScratchpad({ workspaceId: wsId, createdBy: owner, draftId: clientDraft })
    const late = await draftsService.upsert(upsertParams(owner, draftStreamScope(clientDraft)))
    expect(late.draft.scope).toBe(draftStreamScope(clientDraft))
    const baseline = await outboxBaseline()

    const listed = await draftsService.list({ workspaceId: wsId, userId: owner })

    expect(listed.find((draft) => draft.id === late.draft.id)).toEqual(
      expect.objectContaining({
        scope: draftStreamScope(stream.id),
        rootStreamId: stream.id,
        version: late.draft.version + 1,
      })
    )
    const upserted = (await OutboxRepository.fetchAfterId(pool, baseline)).filter(
      (event) => event.eventType === "draft:upserted"
    )
    expect(upserted.map((event) => (event.payload.draft as { id: string; scope: string }).id)).toEqual([late.draft.id])
  })

  test("the same draft id promoted by two users yields two scratchpads and never crosses owners", async () => {
    const clientDraft = clientDraftId()
    const otherDraft = await draftsService.upsert(upsertParams(otherUser, draftStreamScope(clientDraft)))

    const ownerStream = await streamService.createScratchpad({
      workspaceId: wsId,
      createdBy: owner,
      draftId: clientDraft,
    })

    const otherRow = await DraftsRepository.findByIdForUpdate(pool, wsId, otherUser, otherDraft.draft.id)
    expect(otherRow).toEqual(
      expect.objectContaining({
        scope: draftStreamScope(clientDraft),
        rootStreamId: null,
        version: otherDraft.draft.version,
      })
    )

    const otherStream = await streamService.createScratchpad({
      workspaceId: wsId,
      createdBy: otherUser,
      draftId: clientDraft,
    })

    expect(otherStream.id).not.toBe(ownerStream.id)
    expect(await StreamRepository.findById(pool, otherStream.id)).toEqual(
      expect.objectContaining({ id: otherStream.id, createdBy: otherUser, type: "scratchpad" })
    )
    const repointed = await DraftsRepository.findByIdForUpdate(pool, wsId, otherUser, otherDraft.draft.id)
    expect(repointed).toEqual(
      expect.objectContaining({ scope: draftStreamScope(otherStream.id), rootStreamId: otherStream.id })
    )
  })
})
