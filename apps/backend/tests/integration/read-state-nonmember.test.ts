import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, testMessageContent } from "./setup"
import {
  StreamService,
  StreamEventRepository,
  StreamMemberRepository,
  ReadStateRepository,
  usersReadThroughEffective,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId } from "../../src/lib/id"

/**
 * The non-member unlock against a real database: read state is user-anchored,
 * not membership-gated (INV-62) — access-only viewers get the same watermark
 * semantics as members, and `stream_members` is NEVER upserted on a read.
 */
describe("read state — non-member unlock", () => {
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
    await pool.query("DELETE FROM stream_read_state")
    await pool.query("DELETE FROM user_activity")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM stream_members")
    await pool.query("DELETE FROM streams")
    await pool.query(
      "DELETE FROM outbox WHERE id > (SELECT COALESCE(MAX(last_processed_id), 0) FROM outbox_listeners WHERE listener_id = 'broadcast')"
    )
  })

  async function seedChannel(wid: string, sid: string, createdBy: string): Promise<void> {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)`,
      [sid, wid, createdBy]
    )
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

  async function membershipCount(sid: string, uid: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stream_members WHERE stream_id = $1 AND member_id = $2`,
      [sid, uid]
    )
    return result.rows[0].n
  }

  describe("usersReadThroughEffective (born-read gate)", () => {
    test("a non-member's read-state row qualifies — no stream_members row needed", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId() // access-without-membership (INV-62 thread viewer)
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 3)
      const events = await StreamEventRepository.list(pool, sid)

      // The viewer has NO stream_members row — only their own read-state row,
      // advanced through the second event (sequence-resolved in SQL).
      await ReadStateRepository.advance(pool, sid, viewer, events[1].id)

      const readThrough = await usersReadThroughEffective(pool, wid, sid, [viewer], events[1].sequence)
      expect(readThrough).toEqual(new Set([viewer]))

      // A row below the target sequence does not qualify.
      const fresh = userId()
      await ReadStateRepository.advance(pool, sid, fresh, events[0].id)
      const notYet = await usersReadThroughEffective(pool, wid, sid, [fresh], events[1].sequence)
      expect(notYet).toEqual(new Set())
    })

    test("a present NULL watermark (explicit unread-to-zero) does not qualify", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      // An explicit unread-to-zero: the row exists with a NULL watermark, which
      // reads as "before the first message" and never qualifies.
      await StreamMemberRepository.insert(pool, sid, member)
      await ReadStateRepository.set(pool, sid, member, null)

      const readThrough = await usersReadThroughEffective(pool, wid, sid, [member], events[0].sequence)
      expect(readThrough).toEqual(new Set())
    })

    test("a missing read-state row is never-read and does not qualify", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      // Membership alone carries no read truth: with no read-state row the member
      // is never-read and does not qualify.
      await StreamMemberRepository.insert(pool, sid, member)

      const readThrough = await usersReadThroughEffective(pool, wid, sid, [member], events[1].sequence)
      expect(readThrough).toEqual(new Set())
    })

    test("a corrupt frontier pointing at a foreign-stream event never qualifies (event bound to stream)", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      // A foreign stream whose second event sits at/above the target sequence —
      // the shape a corrupt frontier takes when it points outside the user's own
      // stream.
      const foreignWid = workspaceId()
      const foreignSid = streamId()
      await seedChannel(foreignWid, foreignSid, author)
      await sendMessages(foreignWid, foreignSid, author, 2)
      const foreignEvents = await StreamEventRepository.list(pool, foreignSid)

      await StreamMemberRepository.insert(pool, sid, member)
      // Corrupt the frontier directly (bypassing validation) to reference the
      // foreign-stream event id.
      await pool.query(
        `INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id) VALUES ($1, $2, $3, $4)`,
        [wid, sid, member, foreignEvents[1].id]
      )

      // The born-read query binds the watermark event to the frontier's OWN stream
      // (se.stream_id = rs.stream_id) — the foreign event resolves it to no
      // sequence, so the member is NOT born-read despite the foreign sequence
      // sitting past the target. Without the binding this row would falsely qualify.
      const readThrough = await usersReadThroughEffective(pool, wid, sid, [member], events[1].sequence)
      expect(readThrough).toEqual(new Set())
    })
  })

  describe("markAsRead / markUnread for a viewer with no membership row", () => {
    test("markAsRead advances the standalone frontier and emits stream:read in the same tx — never upserting membership", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 3)
      const events = await StreamEventRepository.list(pool, sid)

      const { membership } = await streamService.markAsRead(wid, sid, viewer, events[1].id)

      expect(membership).toBeNull()
      expect(await membershipCount(sid, viewer)).toBe(0)

      const row = await ReadStateRepository.get(pool, sid, viewer)
      expect(row?.lastReadEventId).toBe(events[1].id)
      expect(row?.workspaceId).toBe(wid)

      const emitted = await outboxFor("stream:read", sid)
      expect(emitted).toEqual([
        {
          workspaceId: wid,
          authorId: viewer,
          streamId: sid,
          lastReadEventId: events[1].id,
          lastReadSequence: events[1].sequence.toString(),
          lastReadOrdinal: 2,
          readMessageIds: [],
        },
      ])
    })

    test("markAsRead is monotonic — a stale advance neither regresses the row nor the payload", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 3)
      const events = await StreamEventRepository.list(pool, sid)

      await streamService.markAsRead(wid, sid, viewer, events[2].id)
      await streamService.markAsRead(wid, sid, viewer, events[0].id)

      const row = await ReadStateRepository.get(pool, sid, viewer)
      expect(row?.lastReadEventId).toBe(events[2].id)
      // Both writes emit author-scoped stream:read; the stale one carries the
      // post-write frontier, not the regressed event.
      const emitted = await outboxFor("stream:read", sid)
      expect(emitted.map((p) => p.lastReadEventId)).toEqual([events[2].id, events[2].id])
    })

    test("markUnread regresses the standalone frontier and emits stream:read_set — never upserting membership", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      const [, msg2] = await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      await streamService.markAsRead(wid, sid, viewer, events[1].id)
      const result = await streamService.markUnread(wid, sid, viewer, msg2)

      expect(result).toMatchObject({
        membership: null,
        readState: { lastReadEventId: events[0].id, lastReadSequence: "1" },
      })
      expect(await membershipCount(sid, viewer)).toBe(0)

      const row = await ReadStateRepository.get(pool, sid, viewer)
      expect(row?.lastReadEventId).toBe(events[0].id)

      const emitted = await outboxFor("stream:read_set", sid)
      expect(emitted).toEqual([
        {
          workspaceId: wid,
          authorId: viewer,
          streamId: sid,
          lastReadEventId: events[0].id,
          lastReadSequence: events[0].sequence.toString(),
          lastReadOrdinal: 1,
          readMessageIds: [],
        },
      ])
    })

    test("markAsRead returns the post-write truth — frontier, ordinal, overlay", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 3)
      const events = await StreamEventRepository.list(pool, sid)

      const result = await streamService.markAsRead(wid, sid, viewer, events[1].id)

      expect(result).toEqual({
        membership: null,
        readState: {
          lastReadEventId: events[1].id,
          lastReadSequence: events[1].sequence.toString(),
          lastReadAt: (await ReadStateRepository.get(pool, sid, viewer))!.lastReadAt!.toISOString(),
        },
        lastReadOrdinal: 2,
        readMessageIds: [],
      })
      expect(await outboxFor("stream:read", sid)).toEqual([
        {
          workspaceId: wid,
          authorId: viewer,
          streamId: sid,
          lastReadEventId: events[1].id,
          lastReadSequence: events[1].sequence.toString(),
          lastReadOrdinal: 2,
          readMessageIds: [],
        },
      ])
    })

    test("an event id from another stream is a no-op — null readState, no write, no stream:read", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const otherSid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      await seedChannel(wid, otherSid, author)
      await sendMessages(wid, sid, author, 2)
      await sendMessages(wid, otherSid, author, 1)
      const events = await StreamEventRepository.list(pool, sid)
      const foreign = await StreamEventRepository.list(pool, otherSid)

      // Seed a real frontier first: the no-op must leave it exactly where it was.
      await streamService.markAsRead(wid, sid, viewer, events[0].id)

      const unknown = await streamService.markAsRead(wid, sid, viewer, "event_does_not_exist")
      const crossStream = await streamService.markAsRead(wid, sid, viewer, foreign[0].id)

      expect(unknown).toEqual({ membership: null, readState: null, lastReadOrdinal: null, readMessageIds: null })
      expect(crossStream).toEqual({ membership: null, readState: null, lastReadOrdinal: null, readMessageIds: null })
      const row = await ReadStateRepository.get(pool, sid, viewer)
      expect(row?.lastReadEventId).toBe(events[0].id)
      // Only the seeding read emitted — neither no-op did.
      expect((await outboxFor("stream:read", sid)).map((p) => p.lastReadEventId)).toEqual([events[0].id])
    })

    test("markUnread on the first message parks the frontier before it (null watermark)", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      const [msg1] = await sendMessages(wid, sid, author, 2)

      const result = await streamService.markUnread(wid, sid, viewer, msg1)

      expect(result).toMatchObject({
        membership: null,
        readState: { lastReadEventId: null, lastReadSequence: null },
      })
      const row = await ReadStateRepository.get(pool, sid, viewer)
      expect(row).not.toBeNull()
      expect(row?.lastReadEventId).toBeNull()
    })

    test("markUnread throws MESSAGE_NOT_FOUND for a message outside the stream", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 1)

      await expect(streamService.markUnread(wid, sid, userId(), "msg_elsewhere")).rejects.toMatchObject({
        status: 404,
        code: "MESSAGE_NOT_FOUND",
      })
    })
  })
})

/**
 * Post-bake schema: the membership watermark columns are gone. `stream_read_state`
 * is the sole read truth, so `stream_members` must no longer carry
 * `last_read_event_id` / `last_read_at`.
 */
describe("stream_members watermark columns dropped", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("information_schema no longer contains either membership watermark column", async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'stream_members' AND column_name IN ('last_read_event_id', 'last_read_at')`
    )
    expect(result.rows).toEqual([])
  })
})
