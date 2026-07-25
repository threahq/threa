import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, testMessageContent, withTestTransaction } from "./setup"
import {
  StreamService,
  StreamEventRepository,
  StreamMemberRepository,
  ReadStateRepository,
  usersReadThroughEffective,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { streamId, userId, workspaceId } from "../../src/lib/id"

const MIGRATION_PATH = resolve(import.meta.dir, "../../src/db/migrations/20260724170957_add_stream_read_state.sql")

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

    test("a present NULL watermark does not qualify AND blocks the stale membership fallback", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      // Membership watermark sits past the target (stale shadow-window column),
      // but the authoritative read-state row is an explicit unread-to-zero:
      // present NULL reads as unread and never falls through to membership.
      await StreamMemberRepository.insert(pool, sid, member)
      await StreamMemberRepository.update(pool, sid, member, { lastReadEventId: events[1].id })
      await ReadStateRepository.set(pool, sid, member, null)

      const readThrough = await usersReadThroughEffective(pool, wid, sid, [member], events[0].sequence)
      expect(readThrough).toEqual(new Set())
    })

    test("a missing read-state row falls back to the membership watermark", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      await StreamMemberRepository.insert(pool, sid, member)
      await StreamMemberRepository.update(pool, sid, member, { lastReadEventId: events[1].id })

      const readThrough = await usersReadThroughEffective(pool, wid, sid, [member], events[1].sequence)
      expect(readThrough).toEqual(new Set([member]))
    })

    test("a corrupt membership watermark pointing at a foreign-stream event never qualifies (INV-8 workspace join + event bound to stream)", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const member = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      // A foreign stream in ANOTHER workspace whose second event sits at/above
      // the target sequence — the shape a stale/corrupt membership watermark
      // takes when it points outside the member's own stream.
      const foreignWid = workspaceId()
      const foreignSid = streamId()
      await seedChannel(foreignWid, foreignSid, author)
      await sendMessages(foreignWid, foreignSid, author, 2)
      const foreignEvents = await StreamEventRepository.list(pool, foreignSid)

      await StreamMemberRepository.insert(pool, sid, member)
      // Corrupt the watermark directly (bypassing validation) to reference the
      // foreign-stream event id.
      await pool.query(`UPDATE stream_members SET last_read_event_id = $1 WHERE stream_id = $2 AND member_id = $3`, [
        foreignEvents[1].id,
        sid,
        member,
      ])

      // The membership fallback joins `streams` (workspace must match) and binds
      // the watermark event to the membership's OWN stream — the foreign event
      // resolves neither, so the member is NOT born-read despite the foreign
      // sequence sitting past the target. Without the join/binding this row
      // would falsely qualify.
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

      const membership = await streamService.markAsRead(wid, sid, viewer, events[1].id)

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
      const membership = await streamService.markUnread(wid, sid, viewer, msg2)

      expect(membership).toBeNull()
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

    test("markUnread on the first message parks the frontier before it (null watermark)", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const viewer = userId()
      await seedChannel(wid, sid, author)
      const [msg1] = await sendMessages(wid, sid, author, 2)

      const membership = await streamService.markUnread(wid, sid, viewer, msg1)

      expect(membership).toBeNull()
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
 * Backfill fidelity: the migration copies every non-NULL membership watermark
 * (event id AND timestamp) into stream_read_state with the workspace derived
 * through streams — NULL watermarks seed no row (absence = never read).
 */
describe("stream_read_state migration backfill", () => {
  let pool: Pool
  let migrationSql: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    migrationSql = await Bun.file(MIGRATION_PATH).text()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("copies member watermarks + timestamps with workspace derived through streams; skips NULLs; never clobbers", async () => {
    await withTestTransaction(pool, async (client) => {
      const wid = "ws_backfill_test"
      const sid = "stream_backfill_1"
      const sidNull = "stream_backfill_2"
      const memberWithRead = "usr_backfill_read"
      const readAt = new Date("2026-03-04T05:06:07.000Z")

      await client.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES
           ($1, $2, 'channel', 'private', $4),
           ($3, $2, 'channel', 'private', $4)`,
        [sid, wid, sidNull, memberWithRead]
      )
      // One member with a watermark, one never-read member (NULL) whose row
      // must NOT seed a stream_read_state entry (absence = never read).
      await client.query(
        `INSERT INTO stream_members (stream_id, member_id, last_read_event_id, last_read_at) VALUES
           ($1, $2, 'evt_backfill_9', $4),
           ($3, $2, NULL, NULL)`,
        [sid, memberWithRead, sidNull, readAt]
      )
      // A pre-existing row the backfill must not clobber (ON CONFLICT DO NOTHING).
      await client.query(
        `INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, last_read_at)
         VALUES ($1, $2, $3, 'evt_pre_existing', NULL)`,
        [wid, sid, memberWithRead]
      )

      await client.query(migrationSql)

      const result = await client.query(
        `SELECT workspace_id, stream_id, user_id, last_read_event_id, last_read_at
         FROM stream_read_state
         WHERE workspace_id = $1
         ORDER BY stream_id`,
        [wid]
      )

      // NULL watermark seeded no row; the existing row survived untouched.
      expect(result.rows).toEqual([
        {
          workspace_id: wid,
          stream_id: sid,
          user_id: memberWithRead,
          last_read_event_id: "evt_pre_existing",
          last_read_at: null,
        },
      ])

      // With the conflict out of the way, a fresh backfill carries both the
      // event id and the membership timestamp.
      await client.query(`DELETE FROM stream_read_state WHERE workspace_id = $1`, [wid])
      await client.query(migrationSql)
      const fresh = await client.query(
        `SELECT workspace_id, stream_id, user_id, last_read_event_id, last_read_at
         FROM stream_read_state
         WHERE workspace_id = $1`,
        [wid]
      )
      expect(fresh.rows).toEqual([
        {
          workspace_id: wid,
          stream_id: sid,
          user_id: memberWithRead,
          last_read_event_id: "evt_backfill_9",
          last_read_at: readAt,
        },
      ])
    })
  })
})
