import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, setupTestDatabase, testMessageContent } from "./setup"
import {
  StreamService,
  StreamEventRepository,
  StreamMemberRepository,
  SparseReadRepository,
  ReadStateRepository,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { ConversationService } from "../../src/features/conversations"
import { ActivityRepository } from "../../src/features/activity"
import { streamId, userId, workspaceId, conversationId } from "../../src/lib/id"

describe("ConversationService read/unread", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let conversationService: ConversationService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    conversationService = new ConversationService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM stream_member_message_reads")
    await pool.query("DELETE FROM stream_read_state")
    await pool.query("DELETE FROM user_activity")
    await pool.query("DELETE FROM conversations")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM stream_members")
    await pool.query("DELETE FROM streams")
    await pool.query(
      "DELETE FROM outbox WHERE id > (SELECT COALESCE(MAX(last_processed_id), 0) FROM outbox_listeners WHERE listener_id = 'broadcast')"
    )
  })

  async function send(wid: string, sid: string, authorId: string, text: string): Promise<string> {
    const m = await eventService.createMessage({
      workspaceId: wid,
      streamId: sid,
      authorId,
      authorType: "user",
      ...testMessageContent(text),
    })
    return m.id
  }

  async function setCreatedAt(messageId: string, epochMs: number): Promise<void> {
    await pool.query(`UPDATE messages SET created_at = to_timestamp($1::double precision / 1000.0) WHERE id = $2`, [
      epochMs,
      messageId,
    ])
  }

  async function insertConversation(wid: string, anchorStreamId: string, messageIds: string[]): Promise<string> {
    const id = conversationId()
    await pool.query(
      `INSERT INTO conversations (id, stream_id, workspace_id, message_ids, participant_ids, secondary_message_ids, status, last_activity_at)
       VALUES ($1, $2, $3, $4, '{}'::text[], '{}'::text[], 'active', NOW())`,
      [id, anchorStreamId, wid, messageIds]
    )
    return id
  }

  async function eventByMessage(sid: string): Promise<Map<string, { id: string; sequence: bigint }>> {
    const events = await StreamEventRepository.list(pool, sid)
    return new Map(
      events.map((e) => [(e.payload as { messageId: string }).messageId, { id: e.id, sequence: e.sequence }])
    )
  }

  test("markRead fans out across the streams a conversation spans, bounded by the target's createdAt", async () => {
    const wid = workspaceId()
    const root = streamId()
    const author = userId()
    const reader = userId()
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
        [root, wid, author]
      )
      await StreamMemberRepository.insert(client, root, reader)
    })
    const msg1 = await send(wid, root, author, "root 1")

    // Thread under root; reader has root access but no thread membership row.
    const thread = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [thread, wid, author, root, msg1]
    )
    const tmsg1 = await send(wid, thread, author, "thread 1")
    const msg2 = await send(wid, root, author, "root 2")
    const tmsg2 = await send(wid, thread, author, "thread 2")

    // Deterministic cross-stream ordering by created_at (the card merge key).
    await setCreatedAt(msg1, 1000)
    await setCreatedAt(tmsg1, 2000)
    await setCreatedAt(msg2, 3000)
    await setCreatedAt(tmsg2, 4000)

    const convId = await insertConversation(wid, root, [msg1, tmsg1, msg2, tmsg2])

    const { streams } = await conversationService.markRead({
      workspaceId: wid,
      conversationId: convId,
      throughMessageId: msg2,
      userId: reader,
    })

    const rootEvents = await eventByMessage(root)
    const byStream = new Map(streams.map((s) => [s.streamId, s]))

    // Two streams touched (tmsg2 is past the cutoff, excluded).
    expect([...byStream.keys()].sort()).toEqual([root, thread].sort())

    // Root: msg1+msg2 contiguous from the watermark → compacted, overlay empty.
    expect(byStream.get(root)).toEqual({
      streamId: root,
      readMessageIds: [],
      lastReadEventId: rootEvents.get(msg2)!.id,
      lastReadSequence: rootEvents.get(msg2)!.sequence.toString(),
      lastReadOrdinal: 2,
      markedMessageIds: [msg1, msg2],
    })

    // Thread: non-member leg → compacted into its OWN standalone frontier
    // (only tmsg1; tmsg2 excluded by cutoff), membership never upserted.
    const threadEvents = await eventByMessage(thread)
    const threadSnap = byStream.get(thread)!
    expect(threadSnap.lastReadEventId).toBe(threadEvents.get(tmsg1)!.id)
    expect(threadSnap.lastReadSequence).toBe(threadEvents.get(tmsg1)!.sequence.toString())
    expect(threadSnap.readMessageIds).toEqual([])
    expect(await StreamMemberRepository.findByStreamAndMember(pool, thread, reader)).toBeNull()
    expect((await ReadStateRepository.get(pool, thread, reader))?.lastReadEventId).toBe(threadEvents.get(tmsg1)!.id)
  })

  test("markRead clears activity for exactly the marked messages, never the stream's other topics", async () => {
    const wid = workspaceId()
    const root = streamId()
    const author = userId()
    const reader = userId()
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
        [root, wid, author]
      )
      await StreamMemberRepository.insert(client, root, reader)
    })
    const msg1 = await send(wid, root, author, "topic A opener")
    const msg2 = await send(wid, root, author, "topic B — stays unread")
    await setCreatedAt(msg1, 1000)
    await setCreatedAt(msg2, 2000)
    const convId = await insertConversation(wid, root, [msg1])

    // A mention badge on each message; only the marked conversation's clears.
    for (const messageId of [msg1, msg2]) {
      await ActivityRepository.insert(pool, {
        workspaceId: wid,
        userId: reader,
        activityType: "mention",
        streamId: root,
        messageId,
        actorId: author,
        actorType: "user",
        context: {},
      })
    }

    const { streams } = await conversationService.markRead({
      workspaceId: wid,
      conversationId: convId,
      throughMessageId: msg1,
      userId: reader,
    })

    expect(streams[0]?.markedMessageIds).toEqual([msg1])
    const rows = await pool.query(
      `SELECT message_id, (read_at IS NOT NULL) AS is_read FROM user_activity
       WHERE workspace_id = $1 AND user_id = $2 ORDER BY message_id`,
      [wid, reader]
    )
    expect(new Map(rows.rows.map((r) => [r.message_id, r.is_read]))).toEqual(
      new Map([
        [msg1, true],
        [msg2, false],
      ])
    )
  })

  test("markUnread regresses the watermark on the affected stream and the non-member thread leg's standalone frontier", async () => {
    const wid = workspaceId()
    const root = streamId()
    const author = userId()
    const reader = userId()
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
        [root, wid, author]
      )
      await StreamMemberRepository.insert(client, root, reader)
    })
    const msg1 = await send(wid, root, author, "root 1")
    const thread = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [thread, wid, author, root, msg1]
    )
    const tmsg1 = await send(wid, thread, author, "thread 1")
    const msg2 = await send(wid, root, author, "root 2")
    await setCreatedAt(msg1, 1000)
    await setCreatedAt(tmsg1, 2000)
    await setCreatedAt(msg2, 3000)

    const convId = await insertConversation(wid, root, [msg1, tmsg1, msg2])
    const rootEvents = await eventByMessage(root)

    // Read the whole conversation first. The thread leg (non-member) compacts
    // into its standalone read-state row — no overlay left on the leg.
    await conversationService.markRead({
      workspaceId: wid,
      conversationId: convId,
      throughMessageId: msg2,
      userId: reader,
    })
    expect(await SparseReadRepository.countOverlay(pool, thread, reader)).toBe(0)
    const threadEvents = await eventByMessage(thread)
    expect((await ReadStateRepository.get(pool, thread, reader))?.lastReadEventId).toBe(threadEvents.get(tmsg1)!.id)

    // Now mark unread from tmsg1 (cutoff 2000): tmsg1 + msg2 affected.
    const { streams } = await conversationService.markUnread({
      workspaceId: wid,
      conversationId: convId,
      fromMessageId: tmsg1,
      userId: reader,
    })
    const byStream = new Map(streams.map((s) => [s.streamId, s]))

    // Root: watermark was at msg2 (>= msg2's own seq), regress to just before msg2 → msg1.
    expect(byStream.get(root)!.lastReadEventId).toBe(rootEvents.get(msg1)!.id)
    // Thread leg: tmsg1 was the first message, so the regress parks the
    // standalone frontier before it (null watermark) — membership untouched.
    expect(byStream.get(thread)!.lastReadEventId).toBeNull()
    expect(byStream.get(thread)!.readMessageIds).toEqual([])
    expect(await ReadStateRepository.get(pool, thread, reader)).toMatchObject({ lastReadEventId: null })
    expect(await StreamMemberRepository.findByStreamAndMember(pool, thread, reader)).toBeNull()

    // Effective root unread: msg2 is unread again (msg1 read).
    const membership = await streamService.getMembership(root, reader)
    const counts = await streamService.getUnreadCounts([
      { streamId: root, memberId: reader, lastReadEventId: membership?.lastReadEventId ?? null },
    ])
    expect(counts.get(root)?.unreadCount).toBe(1)
  })

  test("read truth is snapshotted — cutoff uses the target message's own createdAt", async () => {
    const wid = workspaceId()
    const root = streamId()
    const author = userId()
    const reader = userId()
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
        [root, wid, author]
      )
      await StreamMemberRepository.insert(client, root, reader)
    })
    const a = await send(wid, root, author, "a")
    const b = await send(wid, root, author, "b")
    const c = await send(wid, root, author, "c")
    await setCreatedAt(a, 1000)
    await setCreatedAt(b, 2000)
    await setCreatedAt(c, 3000)
    const convId = await insertConversation(wid, root, [a, b, c])

    // Through b → a,b read; c stays unread.
    const { streams } = await conversationService.markRead({
      workspaceId: wid,
      conversationId: convId,
      throughMessageId: b,
      userId: reader,
    })
    expect(streams).toHaveLength(1)
    const membership = await streamService.getMembership(root, reader)
    const counts = await streamService.getUnreadCounts([
      { streamId: root, memberId: reader, lastReadEventId: membership?.lastReadEventId ?? null },
    ])
    expect(counts.get(root)?.unreadCount).toBe(1)
  })
})
