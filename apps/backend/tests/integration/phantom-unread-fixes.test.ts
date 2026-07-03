import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, testMessageContent, addTestMember } from "./setup"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId, activityId } from "../../src/lib/id"

describe("Phantom-unread drift fixes", () => {
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

  beforeEach(async () => {
    await pool.query("DELETE FROM user_activity")
    await pool.query("DELETE FROM stream_member_message_reads")
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

  test("A1: messages:moved carries the post-move source message ordinal", async () => {
    const wid = workspaceId()
    const source = streamId()
    const actor = await addTestMember(pool, wid, userId())
    await StreamRepository.insert(pool, {
      id: source,
      workspaceId: wid,
      type: "channel",
      visibility: "private",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, source, actor.id)

    const target = await send(wid, source, actor.id, "target")
    const keep = await send(wid, source, actor.id, "keep")
    const movedA = await send(wid, source, actor.id, "moved a")
    const movedB = await send(wid, source, actor.id, "moved b")

    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: wid,
      sourceStreamId: source,
      targetMessageId: target,
      messageIds: [movedA, movedB],
      actorId: actor.id,
    })
    await eventService.moveMessagesToThread({
      workspaceId: wid,
      sourceStreamId: source,
      targetMessageId: target,
      messageIds: [movedA, movedB],
      actorId: actor.id,
      leaseKey: validation.leaseKey,
    })

    const moved = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = 'messages:moved' AND payload->>'sourceStreamId' = $1 ORDER BY id DESC LIMIT 1`,
      [source]
    )
    // Source keeps target + keep; movedA/movedB relocated → 2 remain.
    expect(moved.rows[0].payload.sourceMessageOrdinal).toBe(2)
    void keep
  })

  test("A3: a source watermark on a moved event is repointed to the nearest surviving prior event", async () => {
    const wid = workspaceId()
    const source = streamId()
    const actor = await addTestMember(pool, wid, userId())
    const reader = await addTestMember(pool, wid, userId())
    await StreamRepository.insert(pool, {
      id: source,
      workspaceId: wid,
      type: "channel",
      visibility: "private",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, source, actor.id)
    await StreamMemberRepository.insert(pool, source, reader.id)

    const target = await send(wid, source, actor.id, "target")
    const m1 = await send(wid, source, actor.id, "m1")
    const m2 = await send(wid, source, actor.id, "m2")
    const m3 = await send(wid, source, actor.id, "m3")

    const events = await StreamEventRepository.list(pool, source)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // Reader's watermark sits on m2 — which is about to be moved away.
    await streamService.markAsRead(wid, source, reader.id, eventByMsg.get(m2)!.id)
    const before = await streamService.getMembership(source, reader.id)
    expect(before?.lastReadEventId).toBe(eventByMsg.get(m2)!.id)

    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: wid,
      sourceStreamId: source,
      targetMessageId: target,
      messageIds: [m2, m3],
      actorId: actor.id,
    })
    await eventService.moveMessagesToThread({
      workspaceId: wid,
      sourceStreamId: source,
      targetMessageId: target,
      messageIds: [m2, m3],
      actorId: actor.id,
      leaseKey: validation.leaseKey,
    })

    // After the fix: the watermark repoints to m1 (nearest surviving prior source
    // event); without it, it would still point at m2 (now in the thread) and the
    // unread count would resolve against a foreign thread-space sequence.
    const after = await streamService.getMembership(source, reader.id)
    expect(after?.lastReadEventId).toBe(eventByMsg.get(m1)!.id)

    // Source now holds target + m1; nothing unread above m1.
    const counts = await streamService.getUnreadCounts([
      { streamId: source, memberId: reader.id, lastReadEventId: after?.lastReadEventId ?? null },
    ])
    expect(counts.get(source)).toEqual({ unreadCount: 0, totalCount: 2 })
  })

  test("A2: deleting a message marks its unread activity rows read in the same transaction", async () => {
    const wid = workspaceId()
    const source = streamId()
    const actor = await addTestMember(pool, wid, userId())
    const recipient = await addTestMember(pool, wid, userId())
    await StreamRepository.insert(pool, {
      id: source,
      workspaceId: wid,
      type: "channel",
      visibility: "private",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, source, actor.id)

    const msg = await send(wid, source, actor.id, "@mention you")

    // An unread mention activity row for the recipient.
    await pool.query(
      `INSERT INTO user_activity (id, workspace_id, user_id, activity_type, stream_id, message_id, actor_id, actor_type, context, read_at)
       VALUES ($1, $2, $3, 'mention', $4, $5, $6, 'user', '{}'::jsonb, NULL)`,
      [activityId(), wid, recipient.id, source, msg, actor.id]
    )

    await eventService.deleteMessage({
      workspaceId: wid,
      streamId: source,
      messageId: msg,
      actorId: actor.id,
      actorType: "user",
    })

    const row = await pool.query(`SELECT read_at FROM user_activity WHERE message_id = $1`, [msg])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].read_at).not.toBeNull()
  })
})
