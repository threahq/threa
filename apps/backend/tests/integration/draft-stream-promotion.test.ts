/**
 * Promoting a client draft to a scratchpad is idempotent per (owner, draft id),
 * verified against the real schema (INV-68): the partial unique index on
 * `streams.uniqueness_key` absorbs the duplicate insert and the find-or-create
 * hands back the first stream.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository } from "../../src/features/streams"
import { StreamMemberRepository } from "../../src/features/streams/member-repository"
import { OutboxRepository } from "../../src/lib/outbox"
import { userId, workspaceId, draftId } from "../../src/lib/id"

describe("draft stream promotion", () => {
  let pool: Pool
  let streamService: StreamService
  let wsId: string
  let owner: string
  let otherUser: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
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

  test("the same draft id promoted by two users yields two scratchpads", async () => {
    const clientDraft = clientDraftId()

    const ownerStream = await streamService.createScratchpad({
      workspaceId: wsId,
      createdBy: owner,
      draftId: clientDraft,
    })
    const otherStream = await streamService.createScratchpad({
      workspaceId: wsId,
      createdBy: otherUser,
      draftId: clientDraft,
    })

    expect(otherStream.id).not.toBe(ownerStream.id)
    expect(await StreamRepository.findById(pool, otherStream.id)).toEqual(
      expect.objectContaining({ id: otherStream.id, createdBy: otherUser, type: "scratchpad" })
    )
  })
})
