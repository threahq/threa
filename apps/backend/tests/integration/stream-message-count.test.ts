import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool, type PoolClient } from "pg"
import { setupTestDatabase, testMessageContent, addTestMember } from "./setup"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { processChunk } from "../../src/features/streams/message-count-backfill"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { Visibilities, type Visibility } from "@threahq/types"

describe("Stream all-time message count", () => {
  let pool: Pool
  let eventService: EventService
  let streamService: StreamService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    streamService = new StreamService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function setup(visibility: Visibility = Visibilities.PRIVATE) {
    const wsId = workspaceId()
    const sid = streamId()
    const actor = await addTestMember(pool, wsId, userId())
    await StreamRepository.insert(pool, {
      id: sid,
      workspaceId: wsId,
      type: "channel",
      visibility,
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, wsId, sid, actor.id)
    return { wsId, sid, actorId: actor.id }
  }

  async function send(wsId: string, sid: string, authorId: string, text = "hello"): Promise<string> {
    const message = await eventService.createMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId,
      authorType: "user",
      ...testMessageContent(text),
    })
    return message.id
  }

  async function stored(sid: string) {
    const result = await pool.query<{ message_count: number | null; message_count_revision: number }>(
      "SELECT message_count, message_count_revision FROM streams WHERE id = $1",
      [sid]
    )
    return { count: result.rows[0].message_count, revision: result.rows[0].message_count_revision }
  }

  async function published(sid: string) {
    const result = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox WHERE event_type = 'stream:message_count' AND payload->>'streamId' = $1 ORDER BY id",
      [sid]
    )
    return result.rows.map((row) => row.payload)
  }

  test("should count sends and deletes, publish each absolute count, and ignore a repeat delete", async () => {
    const { wsId, sid, actorId } = await setup(Visibilities.PUBLIC)
    const first = await send(wsId, sid, actorId)
    await send(wsId, sid, actorId)
    await eventService.deleteMessageInternal({ workspaceId: wsId, messageId: first, streamId: sid, actorId })
    await eventService.deleteMessageInternal({ workspaceId: wsId, messageId: first, streamId: sid, actorId })

    const base = { workspaceId: wsId, streamId: sid, rootStreamId: null, streamVisibility: Visibilities.PUBLIC }
    expect({ stored: await stored(sid), published: await published(sid) }).toEqual({
      stored: { count: 1, revision: 3 },
      published: [
        { ...base, messageCount: 1, messageCountRevision: 1 },
        { ...base, messageCount: 2, messageCountRevision: 2 },
        { ...base, messageCount: 1, messageCountRevision: 3 },
      ],
    })
  })

  test("should move counts from the source stream to the destination thread", async () => {
    const { wsId, sid, actorId } = await setup()
    const target = await send(wsId, sid, actorId, "target")
    await send(wsId, sid, actorId, "keep")
    const movedA = await send(wsId, sid, actorId, "moved a")
    const movedB = await send(wsId, sid, actorId, "moved b")

    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: wsId,
      sourceStreamId: sid,
      targetMessageId: target,
      messageIds: [movedA, movedB],
      actorId,
    })
    await eventService.moveMessagesToThreadInternal({
      workspaceId: wsId,
      sourceStreamId: sid,
      targetMessageId: target,
      messageIds: [movedA, movedB],
      actorId,
      leaseKey: validation.leaseKey,
    })

    const thread = await pool.query<{ id: string }>("SELECT id FROM streams WHERE parent_stream_id = $1", [sid])
    const threadId = thread.rows[0].id
    expect({
      source: (await stored(sid)).count,
      thread: (await stored(threadId)).count,
      threadEvent: (await published(threadId)).at(-1),
    }).toEqual({
      source: 2,
      thread: 2,
      threadEvent: {
        workspaceId: wsId,
        streamId: threadId,
        rootStreamId: sid,
        streamVisibility: Visibilities.PRIVATE,
        messageCount: 2,
        messageCountRevision: 1,
      },
    })
  })

  /** Whether some backend queues on a lock `holder` owns within two seconds. */
  async function waitForLockWaiter(holder: PoolClient): Promise<boolean> {
    const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    for (let i = 0; i < 40; i++) {
      const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [
        rows[0]!.pid,
      ])
      if ((waiting.rowCount ?? 0) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  async function settle<T>(work: Promise<T>): Promise<string> {
    return work.then(
      () => "ok",
      (error: { code?: string; message?: string }) => error.code ?? error.message ?? "failed"
    )
  }

  test("should route a thread's count event by the visibility its root commits, not a stale snapshot", async () => {
    const { wsId, sid, actorId } = await setup(Visibilities.PUBLIC)
    const anchor = await send(wsId, sid, actorId, "anchor")
    const threadId = streamId()
    await StreamRepository.insert(pool, {
      id: threadId,
      workspaceId: wsId,
      type: "thread",
      visibility: Visibilities.PUBLIC,
      parentStreamId: sid,
      parentAnchorId: anchor,
      rootStreamId: sid,
      createdBy: actorId,
    })
    await pool.query("UPDATE streams SET message_count = 0 WHERE id = $1", [threadId])

    const holder = await pool.connect()
    try {
      await holder.query("BEGIN")
      await holder.query("UPDATE streams SET visibility = 'private' WHERE id = $1", [sid])
      const sent = send(wsId, threadId, actorId, "reply")
      const waited = await waitForLockWaiter(holder)
      await holder.query("COMMIT")
      await sent
      expect({ waited, visibility: (await published(threadId)).at(-1)?.streamVisibility }).toEqual({
        waited: true,
        visibility: Visibilities.PRIVATE,
      })
    } finally {
      holder.release()
    }
  })

  test("should lock the stream before the message on internal deletes and moves, as principal writes do", async () => {
    const { wsId, sid, actorId } = await setup()
    const target = await send(wsId, sid, actorId, "target")
    const deleted = await send(wsId, sid, actorId, "deleted")
    const moved = await send(wsId, sid, actorId, "moved")
    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: wsId,
      sourceStreamId: sid,
      targetMessageId: target,
      messageIds: [moved],
      actorId,
    })

    const writes = [
      {
        messageId: deleted,
        run: () =>
          eventService.deleteMessageInternal({ workspaceId: wsId, messageId: deleted, streamId: sid, actorId }),
      },
      {
        messageId: moved,
        run: () =>
          eventService.moveMessagesToThreadInternal({
            workspaceId: wsId,
            sourceStreamId: sid,
            targetMessageId: target,
            messageIds: [moved],
            actorId,
            leaseKey: validation.leaseKey,
          }),
      },
    ]
    const outcomes = []
    for (const write of writes) {
      const holder = await pool.connect()
      try {
        // The principal order: stream row first, then the message row. The
        // lock timeout sits under deadlock_timeout, so an internal write that
        // already holds the message fails here instead of being retried away.
        await holder.query("BEGIN")
        await holder.query("SET LOCAL lock_timeout = '500ms'")
        await holder.query("SELECT id FROM streams WHERE id = $1 FOR UPDATE", [sid])
        const internal = settle(write.run())
        const waited = await waitForLockWaiter(holder)
        const principal = await settle(
          holder.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE", [write.messageId])
        )
        await holder.query(principal === "ok" ? "COMMIT" : "ROLLBACK")
        outcomes.push({ waited, principal, internal: await internal })
      } finally {
        holder.release()
      }
    }

    const done = { waited: true, principal: "ok", internal: "ok" }
    expect({ outcomes, count: (await stored(sid)).count }).toEqual({ outcomes: [done, done], count: 1 })
  })

  test("should count every concurrent send exactly once", async () => {
    const { wsId, sid, actorId } = await setup()
    await Promise.all(Array.from({ length: 12 }, (_, i) => send(wsId, sid, actorId, `burst ${i}`)))

    expect(await stored(sid)).toEqual({ count: 12, revision: 12 })
  })

  test("should leave an uncounted stream unpublished until the backfill recounts it, then stay idempotent", async () => {
    const { wsId, sid, actorId } = await setup()
    const deleted = await send(wsId, sid, actorId)
    await send(wsId, sid, actorId)
    await eventService.deleteMessageInternal({ workspaceId: wsId, messageId: deleted, streamId: sid, actorId })
    await pool.query("UPDATE streams SET message_count = NULL WHERE id = $1", [sid])
    const publishedBefore = (await published(sid)).length

    await send(wsId, sid, actorId)
    const whileUncounted = {
      stored: (await stored(sid)).count,
      newEvents: (await published(sid)).length - publishedBefore,
    }
    const firstRun = await processChunk({ pool }, wsId, { ids: [sid] })
    const afterBackfill = await stored(sid)
    const secondRun = await processChunk({ pool }, wsId, { ids: [sid] })

    expect({
      whileUncounted,
      firstRun,
      afterBackfill: afterBackfill.count,
      backfillEvent: (await published(sid)).at(-1),
      secondRun,
      revisionAfterRerun: (await stored(sid)).revision,
    }).toEqual({
      whileUncounted: { stored: null, newEvents: 0 },
      firstRun: { processed: 1 },
      afterBackfill: 2,
      backfillEvent: {
        workspaceId: wsId,
        streamId: sid,
        rootStreamId: null,
        streamVisibility: Visibilities.PRIVATE,
        messageCount: 2,
        messageCountRevision: afterBackfill.revision,
      },
      secondRun: { processed: 0 },
      revisionAfterRerun: afterBackfill.revision,
    })
  })

  test("should land on the true count when sends race the backfill recount", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    await pool.query("UPDATE streams SET message_count = NULL WHERE id = $1", [sid])

    await Promise.all([
      processChunk({ pool }, wsId, { ids: [sid] }),
      ...Array.from({ length: 8 }, (_, i) => send(wsId, sid, actorId, `race ${i}`)),
    ])

    expect((await stored(sid)).count).toBe(9)
  })

  test("should start a new stream at zero and expose the count on the stream read", async () => {
    const { wsId, actorId } = await setup()
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `count-${Date.now()}`,
      displayName: "count",
      createdBy: actorId,
      visibility: Visibilities.PUBLIC,
    })
    await send(wsId, channel.id, actorId)

    const read = await StreamRepository.findById(pool, wsId, channel.id)
    expect({ created: channel.messageCount, read: read?.messageCount, revision: read?.messageCountRevision }).toEqual({
      created: 0,
      read: 1,
      revision: 1,
    })
  })
})
