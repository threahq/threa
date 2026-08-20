/**
 * Aside stream-type foundations (PR1): is the new type safe and private at the
 * data layer?
 *
 * An aside is a private, creator-only, companion-backed root stream whose
 * `parent_stream_id`/`parent_anchor_id` are contextual pointers only — never
 * access-bearing (INV-62). These tests pin the seams a default branch would
 * silently break: access, anchor uniqueness, the descendant membership sweep,
 * memo scope, archive inheritance, outbox routing, and the "In this stream"
 * projection.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { resolveMemoScopeForStreamId } from "../../src/features/memos"
import { resolveDeliveryGroups, userGroup, type OutboxEvent } from "../../src/lib/outbox"
import { HttpError } from "../../src/lib/errors"
import { userId, workspaceId, messageId } from "../../src/lib/id"
import { MemoScopes, StreamTypes, StreamErrorCodes, type Stream } from "@threa/types"

describe("Aside foundations", () => {
  let pool: Pool
  let streamService: StreamService
  let wsId: string
  let creator: string
  let member: string
  let sequence = 1n

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      creator = (await addTestMember(client, wsId, userId())).id
      member = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Aside Test Workspace",
        slug: `aside-ws-${wsId.toLowerCase()}`,
        createdBy: creator,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createChannel(slug: string, memberIds: string[] = []): Promise<Stream> {
    return streamService.createChannel({
      workspaceId: wsId,
      slug,
      visibility: "public",
      createdBy: creator,
      memberIds,
    })
  }

  async function insertMessage(streamId: string, authorId: string): Promise<string> {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId,
        sequence: sequence++,
        authorId,
        authorType: "user",
        ...testMessageContent("host message"),
      })
    })
    return id
  }

  async function outboxStreamCreatedFor(streamId: string): Promise<OutboxEvent> {
    const result = await pool.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
      `SELECT id, event_type, payload FROM outbox
       WHERE event_type = 'stream:created' AND payload->>'streamId' = $1`,
      [streamId]
    )
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    return { id: BigInt(row.id), eventType: row.event_type, payload: row.payload, createdAt: new Date() } as OutboxEvent
  }

  test("aside is creator-only, including a thread inside it (INV-62)", async () => {
    const channel = await createChannel("aside-access", [member])
    const anchorId = await insertMessage(channel.id, member)

    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    expect(aside).toMatchObject({
      type: StreamTypes.ASIDE,
      visibility: "private",
      companionMode: "on",
      memoryMode: "off",
      rootStreamId: null,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
    })

    expect(await streamService.tryAccess(aside.id, wsId, creator)).not.toBeNull()
    expect(await streamService.tryAccess(aside.id, wsId, member)).toBeNull()

    const asideMessage = await insertMessage(aside.id, creator)
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: aside.id,
      parentAnchorId: asideMessage,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    expect(thread.rootStreamId).toBe(aside.id)
    expect(await streamService.tryAccess(thread.id, wsId, creator)).not.toBeNull()
    expect(await streamService.tryAccess(thread.id, wsId, member)).toBeNull()
  })

  test("multiple asides share an anchor; a thread on the same anchor is a real thread", async () => {
    const channel = await createChannel("aside-anchor")
    const anchorId = await insertMessage(channel.id, creator)

    const first = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    const second = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    expect(second.id).not.toBe(first.id)
    expect(second.type).toBe(StreamTypes.ASIDE)

    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    expect(thread.type).toBe(StreamTypes.THREAD)
    expect([first.id, second.id]).not.toContain(thread.id)

    const threadsByAnchor = await StreamRepository.findThreadsForMessages(pool, channel.id)
    expect(threadsByAnchor.get(anchorId)).toBe(thread.id)
  })

  test("channel kick sweeps thread membership but preserves the member's aside", async () => {
    const channel = await createChannel("aside-kick", [member])
    const anchorId = await insertMessage(channel.id, creator)

    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: member,
    })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: member,
      principal: { kind: "user", userId: member },
    })
    expect(await StreamMemberRepository.isMember(pool, thread.id, member)).toBe(true)

    await streamService.removeMember(channel.id, member, wsId, creator)

    expect(await StreamMemberRepository.isMember(pool, channel.id, member)).toBe(false)
    expect(await StreamMemberRepository.isMember(pool, thread.id, member)).toBe(false)
    expect(await StreamMemberRepository.isMember(pool, aside.id, member)).toBe(true)
  })

  test("memo scope for an aside is the creator's user tier", async () => {
    const channel = await createChannel("aside-memo")
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      createdBy: creator,
    })

    const scope = await resolveMemoScopeForStreamId(pool, aside.id)
    expect(scope).toEqual({ scope: MemoScopes.USER, scopeUserId: creator, rootStreamId: aside.id })
  })

  test("aside is read-only while its direct parent is archived", async () => {
    const channel = await createChannel("aside-archive-direct")
    const anchorId = await insertMessage(channel.id, creator)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })

    await streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })

    await streamService.archiveStream(channel.id, wsId, creator)
    expect(streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })).rejects.toMatchObject({
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: "archived" },
    })

    await streamService.unarchiveStream(channel.id, wsId, creator)
    await streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })
  })

  test("aside anchored in a thread is read-only when the thread's root is archived", async () => {
    const channel = await createChannel("aside-archive-root")
    const anchorId = await insertMessage(channel.id, creator)
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    const threadMessage = await insertMessage(thread.id, creator)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: thread.id,
      parentAnchorId: threadMessage,
      createdBy: creator,
    })

    await streamService.archiveStream(channel.id, wsId, creator)
    expect(streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })).rejects.toMatchObject({
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: "archived" },
    })
  })

  test("aside stream:created routes to the creator group only", async () => {
    const channel = await createChannel("aside-routing", [member])
    const anchorId = await insertMessage(channel.id, creator)
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })

    const event = await outboxStreamCreatedFor(aside.id)
    expect(resolveDeliveryGroups(event)).toEqual([userGroup(creator)])
  })

  test("anchor must belong to the parent stream", async () => {
    const channel = await createChannel("aside-anchor-mismatch")
    const otherChannel = await createChannel("aside-anchor-elsewhere")
    const foreignAnchor = await insertMessage(otherChannel.id, creator)

    expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: foreignAnchor,
        createdBy: creator,
      })
    ).rejects.toBeInstanceOf(HttpError)
  })

  test("threads project into stream_context_items; asides never do", async () => {
    const channel = await createChannel("aside-context")
    const anchorId = await insertMessage(channel.id, creator)

    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })

    const items = await pool.query<{ ref_id: string }>(`SELECT ref_id FROM stream_context_items WHERE stream_id = $1`, [
      channel.id,
    ])
    const refIds = items.rows.map((row) => row.ref_id)
    expect(refIds).toContain(thread.id)
    expect(refIds).not.toContain(aside.id)
  })
})
