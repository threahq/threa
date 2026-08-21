/**
 * Aside stream-type foundations (PR1): is the new type safe and private at the
 * data layer?
 *
 * An aside is a private, creator-only, companion-backed root stream whose
 * `parent_stream_id`/`parent_anchor_id` are contextual pointers only — never
 * access-bearing (INV-62). These tests pin the seams a default branch would
 * silently break: access, the descendant membership sweep, memo scope, archive
 * inheritance, outbox routing, and the "In this stream" projection.
 *
 * Cross-type anchor sharing (aside + thread on ONE anchor, multiple asides per
 * anchor) is deliberately absent: it needs the untyped anchor index dropped,
 * which happens in the stack's final layer. Those tests are parked in the
 * aside-build scratchpad (`pr8-parked-tests/`) until then; everything here
 * passes with BOTH indexes present.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { DynamicNamingStreamTarget } from "../../src/features/dynamic-naming"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import { MemoService, resolveMemoScopeForStreamId } from "../../src/features/memos"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { resolveDeliveryGroups, userGroup, type OutboxEvent } from "../../src/lib/outbox"
import { userId, workspaceId, messageId } from "../../src/lib/id"
import { MemoScopes, StreamTypes, StreamErrorCodes, type Stream } from "@threa/types"

const EMBEDDING_DIMENSIONS = 1536

describe("Aside foundations", () => {
  let pool: Pool
  let streamService: StreamService
  let memoService: MemoService
  let wsId: string
  let creator: string
  let member: string
  let sequence = 1n
  let embeddingsIssued = 0

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    memoService = new MemoService({
      pool,
      classifier: {} as never,
      memorizer: {} as never,
      messageFormatter: {} as never,
      embeddingService: {
        embedBatch: async (texts: string[]) =>
          texts.map(() => {
            const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
            vector[embeddingsIssued++ % EMBEDDING_DIMENSIONS] = 1
            return vector
          }),
      } as unknown as EmbeddingServiceLike,
    })
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
    // The persisted thread row copies the aside's companion setting (C2).
    expect(thread.companionMode).toBe("on")
    expect(await streamService.tryAccess(thread.id, wsId, creator)).not.toBeNull()
    expect(await streamService.tryAccess(thread.id, wsId, member)).toBeNull()
  })

  test("channel kick sweeps thread membership but preserves the member's aside", async () => {
    const channel = await createChannel("aside-kick", [member])
    const asideAnchor = await insertMessage(channel.id, creator)
    const threadAnchor = await insertMessage(channel.id, creator)

    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: asideAnchor,
      createdBy: member,
    })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: threadAnchor,
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

  test("save_memo with a workspace override from an aside lands user-scoped", async () => {
    const channel = await createChannel("aside-memo-clamp")
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      createdBy: creator,
    })
    const sourceId = await insertMessage(aside.id, creator)

    const saved = await memoService.saveMemo({
      workspaceId: wsId,
      streamId: aside.id,
      sessionId: null,
      sourceStreamIds: [aside.id],
      title: "Churn numbers are quarterly",
      abstract: "The churn figures in the deck are quarterly, not monthly.",
      keyPoints: ["quarterly"],
      tags: ["metrics"],
      knowledgeType: "context",
      sourceMessageIds: [sourceId],
      invokingUserId: creator,
      scope: MemoScopes.WORKSPACE,
    })
    expect(saved).toMatchObject({ ok: true })

    const memo = await pool.query<{ scope: string; scope_user_id: string | null }>(
      `SELECT scope, scope_user_id FROM memos WHERE id = $1`,
      [(saved as { memoId: string }).memoId]
    )
    expect(memo.rows[0]).toEqual({ scope: MemoScopes.USER, scope_user_id: creator })
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
    await expect(streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })).rejects.toMatchObject(
      {
        code: StreamErrorCodes.READ_ONLY,
        details: { reason: "archived" },
      }
    )

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
    await expect(streamService.assertWritable(aside.id, wsId, { kind: "user", userId: creator })).rejects.toMatchObject(
      {
        code: StreamErrorCodes.READ_ONLY,
        details: { reason: "archived" },
      }
    )
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

    await expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: foreignAnchor,
        createdBy: creator,
      })
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" })
  })

  test("an aside cannot host another aside", async () => {
    const channel = await createChannel("aside-no-nesting")
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      createdBy: creator,
    })

    await expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: aside.id,
        createdBy: creator,
      })
    ).rejects.toMatchObject({ code: "ASIDE_HOST_TYPE_INVALID" })
  })

  test("an aside cannot be opened on an archived host", async () => {
    const channel = await createChannel("aside-archived-host")
    const anchorId = await insertMessage(channel.id, creator)
    await streamService.archiveStream(channel.id, wsId, creator)

    await expect(
      streamService.createAside({
        workspaceId: wsId,
        parentStreamId: channel.id,
        parentAnchorId: anchorId,
        createdBy: creator,
      })
    ).rejects.toMatchObject({ code: StreamErrorCodes.READ_ONLY, details: { reason: "archived" } })
  })

  test("naming context for an aside lists only the creator's own aside titles", async () => {
    const channel = await createChannel("aside-naming-titles", [member])
    const asideOf = (userId: string, displayName?: string) =>
      insertMessage(channel.id, creator).then((anchorId) =>
        streamService.createAside({
          workspaceId: wsId,
          parentStreamId: channel.id,
          parentAnchorId: anchorId,
          createdBy: userId,
          displayName,
        })
      )
    await asideOf(creator, "Creator's other aside")
    await asideOf(member, "Member's private aside")
    const target = await asideOf(creator)
    await insertMessage(target.id, creator)

    const context = await new DynamicNamingStreamTarget(pool, new MessageFormatter()).loadContext({
      workspaceId: wsId,
      targetKind: "stream",
      targetId: target.id,
      messageCount: 1,
      latestMessageAt: new Date(),
      title: null,
      titleSource: null,
      titleRevision: 0,
    })

    expect(context?.existingTitles).toEqual(["Creator's other aside"])
  })

  test("threads project into stream_context_items; asides never do", async () => {
    const channel = await createChannel("aside-context")
    const asideAnchor = await insertMessage(channel.id, creator)
    const threadAnchor = await insertMessage(channel.id, creator)

    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: asideAnchor,
      createdBy: creator,
    })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: threadAnchor,
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
