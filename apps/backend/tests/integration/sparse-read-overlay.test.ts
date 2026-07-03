import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { withTransaction, setupTestDatabase, testMessageContent } from "./setup"
import {
  StreamService,
  StreamEventRepository,
  StreamMemberRepository,
  SparseReadRepository,
  applySparseRead,
  applySparseUnread,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId } from "../../src/lib/id"

describe("Sparse read overlay", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
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

  async function seedChannel(memberIds: string[]): Promise<{ wid: string; sid: string; authorId: string }> {
    const wid = workspaceId()
    const sid = streamId()
    const authorId = userId()
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
        [sid, wid, authorId]
      )
      for (const m of memberIds) await StreamMemberRepository.insert(client, sid, m)
    })
    return { wid, sid, authorId }
  }

  async function sendMessages(wid: string, sid: string, authorId: string, count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 1; i <= count; i++) {
      const m = await eventService.createMessage({
        workspaceId: wid,
        streamId: sid,
        authorId,
        authorType: "user",
        ...testMessageContent(`Message ${i}`),
      })
      ids.push(m.id)
    }
    return ids
  }

  async function outboxFor(eventType: string, sid: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'streamId' = $2 ORDER BY id`,
      [eventType, sid]
    )
    return result.rows.map((r) => r.payload)
  }

  async function effectiveUnread(sid: string, memberId: string): Promise<number> {
    const membership = await streamService.getMembership(sid, memberId)
    const counts = await streamService.getUnreadCounts([
      { streamId: sid, memberId, lastReadEventId: membership?.lastReadEventId ?? null },
    ])
    return counts.get(sid)?.unreadCount ?? 0
  }

  test("a non-contiguous overlay read drops effective unread without advancing the watermark", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [, , msg3] = await sendMessages(wid, sid, authorId, 3)

    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )

    // msg1 above the (null) watermark isn't covered, so no compaction: the
    // watermark stays put and the overlay holds the single hole.
    expect(snapshot).toEqual({
      streamId: sid,
      readMessageIds: [msg3],
      lastReadEventId: null,
      lastReadSequence: "0",
      lastReadOrdinal: 0,
      markedMessageIds: [msg3],
    })
    expect(await effectiveUnread(sid, reader)).toBe(2)

    const emitted = await outboxFor("stream:read_messages", sid)
    expect(emitted).toEqual([
      {
        workspaceId: wid,
        authorId: reader,
        streamId: sid,
        readMessageIds: [msg3],
        lastReadEventId: null,
        lastReadSequence: "0",
        lastReadOrdinal: 0,
        markedMessageIds: [msg3],
      },
    ])
  })

  test("compaction absorbs the contiguous run into the watermark and prunes the overlay", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // Read the hole first (msg3), then the run below it (msg1, msg2): the whole
    // 1..3 run is now contiguous from the watermark, so compaction advances to
    // msg3 and prunes every absorbed row.
    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg1, msg2] })
    )

    expect(snapshot).toEqual({
      streamId: sid,
      readMessageIds: [],
      lastReadEventId: eventByMsg.get(msg3)!.id,
      lastReadSequence: eventByMsg.get(msg3)!.sequence.toString(),
      lastReadOrdinal: 3,
      markedMessageIds: [msg1, msg2],
    })
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    expect(await effectiveUnread(sid, reader)).toBe(0)
  })

  test("a non-member thread leg is overlay-only — no membership row, no watermark", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [parentMsg] = await sendMessages(wid, sid, authorId, 1)

    // A thread under the channel root; reader has access via the root but no
    // thread membership row.
    const threadId = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_message_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [threadId, wid, authorId, sid, parentMsg]
    )
    const threadMsgs = await sendMessages(wid, threadId, authorId, 2)

    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: threadId, memberId: reader, messageIds: threadMsgs })
    )

    expect(snapshot.lastReadEventId).toBeNull()
    expect(snapshot.lastReadSequence).toBe("0")
    expect(snapshot.readMessageIds.sort()).toEqual([...threadMsgs].sort())
    // Overlay-only: no membership row was upserted (membership ≠ access, INV-62).
    expect(await StreamMemberRepository.findByStreamAndMember(pool, threadId, reader)).toBeNull()
    expect(await SparseReadRepository.countOverlay(pool, threadId, reader)).toBe(2)
  })

  test("double-applying the same read is idempotent (ON CONFLICT) and order-convergent", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [, , msg3] = await sendMessages(wid, sid, authorId, 3)

    const first = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    const second = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )

    expect(second).toEqual(first)
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(1)
  })

  test("overlay rows are workspace-tagged and member-scoped (INV-8)", async () => {
    const reader = userId()
    const other = userId()
    const { wid, sid, authorId } = await seedChannel([reader, other])
    const [, , msg3] = await sendMessages(wid, sid, authorId, 3)

    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )

    const row = await pool.query(
      `SELECT workspace_id, member_id FROM stream_member_message_reads WHERE stream_id = $1 AND message_id = $2`,
      [sid, msg3]
    )
    expect(row.rows).toEqual([{ workspace_id: wid, member_id: reader }])
    // The other member's count is untouched by reader's overlay.
    expect(await effectiveUnread(sid, other)).toBe(3)
    expect(await effectiveUnread(sid, reader)).toBe(2)
  })

  test("markAsRead advancing past a hole prunes it and reports the empty overlay", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [, , msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    // Timeline mark-as-read up to the latest event absorbs the hole.
    await streamService.markAsRead(wid, sid, reader, eventByMsg.get(msg3)!.id)

    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    const readPayloads = await outboxFor("stream:read", sid)
    expect(readPayloads.at(-1)?.readMessageIds).toEqual([])
    expect(await effectiveUnread(sid, reader)).toBe(0)
  })

  test("mark-unread from a message regresses the watermark and clears overlay at/above it", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // Read everything, then a conversation-style unread from msg2 via the stream
    // watermark path: overlay above msg2 is dropped and the pointer regresses.
    await streamService.markAsRead(wid, sid, reader, eventByMsg.get(msg3)!.id)
    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    await streamService.markUnread(wid, sid, reader, msg2)

    const membership = await streamService.getMembership(sid, reader)
    expect(membership?.lastReadEventId).toBe(eventByMsg.get(msg1)!.id)
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    // msg2, msg3 unread again.
    expect(await effectiveUnread(sid, reader)).toBe(2)
  })

  test("a deleted message inside the run counts as covered — the tide rises over sunken rocks", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // msg2 deleted: nobody can ever read it, so it must not hold the watermark
    // down. Reading msg1 + msg3 compacts the whole run.
    await eventService.deleteMessage({ workspaceId: wid, streamId: sid, messageId: msg2, actorId: authorId })
    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg1, msg3] })
    )

    expect(snapshot.lastReadEventId).toBe(eventByMsg.get(msg3)!.id)
    expect(snapshot.readMessageIds).toEqual([])
    expect(await effectiveUnread(sid, reader)).toBe(0)
  })

  test("a trailing deleted run above the last read is absorbed into the watermark", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // msg2 and msg3 deleted AFTER msg1 is the only live content: reading msg1
    // must lift the watermark over the dead tail to msg3, or the stream can
    // never fully read from the board (the compaction window is bounded by the
    // overlay's max sequence, which sits below the deleted run).
    await eventService.deleteMessage({ workspaceId: wid, streamId: sid, messageId: msg2, actorId: authorId })
    await eventService.deleteMessage({ workspaceId: wid, streamId: sid, messageId: msg3, actorId: authorId })
    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg1] })
    )

    expect(snapshot.lastReadEventId).toBe(eventByMsg.get(msg3)!.id)
    expect(snapshot.readMessageIds).toEqual([])
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    expect(await effectiveUnread(sid, reader)).toBe(0)
  })

  test("members at/below the watermark never survive in the overlay (no double-subtract)", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, , msg4] = await sendMessages(wid, sid, authorId, 4)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // Timeline read through msg2, then a conversation whose members straddle the
    // watermark ({msg1, msg4}) is marked read while msg3 (another conversation)
    // stays a hole above the watermark — so no compaction fires. msg1 sits below
    // the watermark and must be pruned, not inserted: a surviving row would
    // double-subtract and hide msg3's genuine unread.
    await streamService.markAsRead(wid, sid, reader, eventByMsg.get(msg2)!.id)
    const snapshot = await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg1, msg4] })
    )

    expect(snapshot.readMessageIds).toEqual([msg4])
    const belowWatermark = await pool.query(
      `SELECT message_id FROM stream_member_message_reads
       WHERE stream_id = $1 AND member_id = $2 AND sequence <= $3`,
      [sid, reader, eventByMsg.get(msg2)!.sequence.toString()]
    )
    expect(belowWatermark.rows).toEqual([])
    // msg3 is the one genuinely unread message.
    expect(await effectiveUnread(sid, reader)).toBe(1)
  })

  test("mark-unread that ADVANCES the watermark past overlay holes clears them too", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, , msg3, msg4] = await sendMessages(wid, sid, authorId, 4)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    // Watermark at msg1, board-read hole at msg3. Mark-unread from msg4 lands the
    // pointer on msg3 — an ADVANCE, not a regress. The absorbed hole (msg3) is now
    // at the watermark and must be pruned or it double-subtracts, reporting the
    // just-marked-unread msg4 as read.
    await streamService.markAsRead(wid, sid, reader, eventByMsg.get(msg1)!.id)
    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    await streamService.markUnread(wid, sid, reader, msg4)

    const membership = await streamService.getMembership(sid, reader)
    expect(membership?.lastReadEventId).toBe(eventByMsg.get(msg3)!.id)
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    expect(await effectiveUnread(sid, reader)).toBe(1)
  })

  test("removing a member purges their overlay so a born-read rejoin can't undercount", async () => {
    const reader = userId()
    const other = userId()
    const { wid, sid, authorId } = await seedChannel([reader, other])
    const [, , msg3] = await sendMessages(wid, sid, authorId, 3)

    // Board-read hole, then the member is removed. The overlay must go with the
    // membership: a rejoin born-reads the watermark at latest, and a surviving
    // row below it would double-subtract in the effective unread count.
    await withTransaction(pool, (client) =>
      applySparseRead(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg3] })
    )
    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(1)

    await streamService.removeMember(sid, reader)

    expect(await SparseReadRepository.countOverlay(pool, sid, reader)).toBe(0)
    // The other member's overlay state is untouched by reader's removal.
    expect(await effectiveUnread(sid, other)).toBe(3)
  })

  test("applySparseUnread drops the affected ids and regresses when the watermark is past them", async () => {
    const reader = userId()
    const { wid, sid, authorId } = await seedChannel([reader])
    const [msg1, msg2, msg3] = await sendMessages(wid, sid, authorId, 3)
    const events = await StreamEventRepository.list(pool, sid)
    const eventByMsg = new Map(events.map((e) => [(e.payload as { messageId: string }).messageId, e]))

    await streamService.markAsRead(wid, sid, reader, eventByMsg.get(msg3)!.id)
    const snapshot = await withTransaction(pool, (client) =>
      applySparseUnread(client, { workspaceId: wid, streamId: sid, memberId: reader, messageIds: [msg2, msg3] })
    )

    // Earliest affected is msg2; the watermark regresses to just before it (msg1).
    expect(snapshot).toEqual({
      streamId: sid,
      readMessageIds: [],
      lastReadEventId: eventByMsg.get(msg1)!.id,
      lastReadSequence: eventByMsg.get(msg1)!.sequence.toString(),
      lastReadOrdinal: 1,
    })
    const setPayloads = await outboxFor("stream:read_set", sid)
    expect(setPayloads.at(-1)?.lastReadEventId).toBe(eventByMsg.get(msg1)!.id)
    expect(await effectiveUnread(sid, reader)).toBe(2)
  })
})
