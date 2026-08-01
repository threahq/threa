/**
 * `memo:created` — who is told a memo exists, and what they are told.
 *
 * The event fires whenever GAM captures knowledge, and its payload is copied
 * verbatim into `sync_log`, where catch-up replays it for weeks. Routing is
 * decided by the event TYPE (`STREAM_SCOPED_EVENTS`), never by the payload's
 * shape, so an outbox row can look perfectly stream-scoped while being
 * delivered to the whole workspace — which is why these tests run the row
 * through `resolveDeliveryGroups` and then through the catch-up read, rather
 * than asserting on the row alone.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { MemoService } from "../../src/features/memos"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { SyncLogRepository } from "../../src/features/sync"
import { resolveDeliveryGroups, streamGroup, userGroup, WORKSPACE_GROUP, type OutboxEvent } from "../../src/lib/outbox"
import { userId, workspaceId, streamId, messageId } from "../../src/lib/id"

const EMBEDDING_DIMENSIONS = 1536

/** Distinct unit vectors per abstract, so nothing in a suite of one-line memos
 *  lands inside the dedup radius of the memo before it. */
function fakeEmbedding(index: number): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
  vector[index % EMBEDDING_DIMENSIONS] = 1
  return vector
}

describe("memo:created delivery", () => {
  let pool: Pool
  let service: MemoService
  let testWorkspaceId: string
  /** Member of the private channel every memo below is captured from. */
  let insider: string
  /** A workspace member with no access to it. */
  let outsider: string
  let privateChannel: string
  let sequence = 1n
  let embeddingsIssued = 0

  /** The `memo:created` outbox row for one memo, as the dispatcher reads it. */
  async function outboxEventFor(memoId: string): Promise<OutboxEvent> {
    const result = await pool.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
      `SELECT id, event_type, payload FROM outbox WHERE event_type = 'memo:created' AND payload->>'memoId' = $1`,
      [memoId]
    )
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    return { id: BigInt(row.id), eventType: row.event_type, payload: row.payload, createdAt: new Date() } as OutboxEvent
  }

  /** Logs the event under its resolved groups, exactly as the BroadcastHandler
   *  does, and answers who catch-up hands it back to. */
  async function catchUpReceivers(event: OutboxEvent, groups: string[], users: string[]): Promise<string[]> {
    await SyncLogRepository.appendForWorkspace(pool, testWorkspaceId, [
      { outboxEventId: event.id, eventType: event.eventType, groups, payload: event.payload },
    ])
    const received: string[] = []
    for (const user of users) {
      const entries = await SyncLogRepository.listEntriesForUser(pool, {
        workspaceId: testWorkspaceId,
        userId: user,
        permissionGroups: [],
        after: 0n,
        limit: 100,
      })
      if (
        entries.some((e) => (e.payload as { memoId?: string }).memoId === (event.payload as { memoId: string }).memoId)
      ) {
        received.push(user)
      }
    }
    return received
  }

  /** A real message in `stream` for the memo to anchor to. */
  async function anchorMessage(stream: string): Promise<string> {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId: stream,
        sequence: sequence++,
        authorId: insider,
        authorType: "user",
        ...testMessageContent("source"),
      })
    })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new MemoService({
      pool,
      classifier: {} as never,
      memorizer: {} as never,
      messageFormatter: {} as never,
      embeddingService: {
        embedBatch: async (texts: string[]) => texts.map(() => fakeEmbedding(embeddingsIssued++)),
      } as unknown as EmbeddingServiceLike,
    })

    testWorkspaceId = workspaceId()
    insider = userId()
    privateChannel = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Created Routing",
        slug: `memo-created-${testWorkspaceId}`,
        createdBy: insider,
      })
      insider = (await addTestMember(client, testWorkspaceId, insider)).id
      outsider = (await addTestMember(client, testWorkspaceId, userId())).id

      await StreamRepository.insert(client, {
        id: privateChannel,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        slug: `s-${privateChannel.slice(-8)}`,
        createdBy: insider,
      })
      await StreamMemberRepository.insert(client, privateChannel, insider)
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a memo from a private channel reaches that channel's room and no one else", async () => {
    const anchor = await anchorMessage(privateChannel)
    const saved = await service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: privateChannel,
      sessionId: null,
      sourceStreamIds: [privateChannel],
      title: "Ship the migration on Tuesday",
      abstract: "The team agreed to ship the migration on Tuesday.",
      keyPoints: ["Tuesday"],
      tags: ["release"],
      knowledgeType: "decision",
      sourceMessageIds: [anchor],
      invokingUserId: insider,
    })
    expect(saved).toMatchObject({ ok: true, deduped: false })

    const event = await outboxEventFor((saved as { memoId: string }).memoId)

    // The whole payload: nothing of what the memo says survives onto the wire,
    // so the ~30-day sync_log tail holds an id and a room, not knowledge.
    expect(event.payload).toEqual({
      workspaceId: testWorkspaceId,
      streamId: privateChannel,
      memoId: (saved as { memoId: string }).memoId,
    })

    const groups = resolveDeliveryGroups(event)
    expect(groups).toEqual([streamGroup(privateChannel)])
    expect(groups).not.toContain(WORKSPACE_GROUP)

    expect(await catchUpReceivers(event, groups!, [insider, outsider])).toEqual([insider])
  })

  test("a user-scoped memo saved into a shared stream reaches only its owner", async () => {
    // save_memo can file privately from a stream whose audience is wider than
    // the owner. The room must not learn that a memo it will never be shown
    // exists — so this one routes to the owner, not to the channel.
    const anchor = await anchorMessage(privateChannel)
    const saved = await service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: privateChannel,
      sessionId: null,
      sourceStreamIds: [privateChannel],
      title: "Kris prefers terse status replies",
      abstract: "Kris prefers status replies to lead with the result and stay under six lines.",
      keyPoints: ["terse"],
      tags: ["preferences"],
      knowledgeType: "context",
      sourceMessageIds: [anchor],
      invokingUserId: insider,
      scope: "user",
    })
    expect(saved).toMatchObject({ ok: true, deduped: false })

    const event = await outboxEventFor((saved as { memoId: string }).memoId)
    expect(event.payload).toMatchObject({ streamId: privateChannel, scopeUserId: insider })

    const groups = resolveDeliveryGroups(event)
    expect(groups).toEqual([userGroup(insider)])
  })

  test("a memo saved from a thread routes to the thread's root, whose members it belongs to", async () => {
    // The capture stream can be a thread; a thread room holds only whoever has
    // it open, while access is the root's (INV-62). Routing to the thread would
    // silently starve the members the memo actually belongs to.
    const thread = streamId()
    const parentMessage = await anchorMessage(privateChannel)
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: thread,
        workspaceId: testWorkspaceId,
        type: "thread",
        visibility: "private",
        slug: `s-${thread.slice(-8)}`,
        createdBy: insider,
        parentStreamId: privateChannel,
        parentAnchorId: parentMessage,
        rootStreamId: privateChannel,
      })
    })
    const anchor = await anchorMessage(thread)

    const saved = await service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: thread,
      sessionId: null,
      sourceStreamIds: [thread],
      title: "The retry budget is three attempts",
      abstract: "The queue retries a failed job three times before dead-lettering it.",
      keyPoints: ["three"],
      tags: ["queue"],
      knowledgeType: "decision",
      sourceMessageIds: [anchor],
      invokingUserId: insider,
    })
    expect(saved).toMatchObject({ ok: true, deduped: false })

    const event = await outboxEventFor((saved as { memoId: string }).memoId)
    expect(event.payload).toEqual({
      workspaceId: testWorkspaceId,
      streamId: privateChannel,
      memoId: (saved as { memoId: string }).memoId,
    })
    expect(resolveDeliveryGroups(event)).toEqual([streamGroup(privateChannel)])
  })
})
