import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, testMessageContent } from "./setup"
import { StreamService, StreamEventRepository, StreamMemberRepository, ReadStateRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { ActivityRepository, ActivityService } from "../../src/features/activity"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { ActivityTypes } from "@threahq/types"

/**
 * The sidebar Inbox hold against a real database: `stream_read_state.inbox_held`
 * flips true only when a hold-eligible advance crosses another user's
 * `message_created` event, and only `clearInbox`/`clearInboxHeld` unpin it
 * (INV-62 access, INV-20 race-safe upserts).
 */
describe("inbox hold", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let activityService: ActivityService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    activityService = new ActivityService({ pool })
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

  async function seedChannel(
    wid: string,
    sid: string,
    createdBy: string,
    visibility: "public" | "private" = "public"
  ): Promise<void> {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', $3, $4)`,
      [sid, wid, visibility, createdBy]
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

  async function outboxFor(eventType: string): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query(`SELECT payload FROM outbox WHERE event_type = $1 ORDER BY id`, [eventType])
    return result.rows.map((r) => r.payload)
  }

  describe("ReadStateRepository.advance", () => {
    test("holds when the advance crosses another user's message with holdInInbox true", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const reader = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 1)
      const [evt] = await StreamEventRepository.list(pool, sid)

      const { becameHeld, state } = await ReadStateRepository.advance(pool, sid, reader, evt.id, {
        holdInInbox: true,
      })

      expect(becameHeld).toBe(true)
      expect(state?.inboxHeld).toBe(true)
    })

    test("does not hold when the crossed events are the reader's own messages", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const reader = userId()
      await seedChannel(wid, sid, reader)
      await sendMessages(wid, sid, reader, 1)
      const [evt] = await StreamEventRepository.list(pool, sid)

      const { becameHeld, state } = await ReadStateRepository.advance(pool, sid, reader, evt.id, {
        holdInInbox: true,
      })

      expect(becameHeld).toBe(false)
      expect(state?.inboxHeld).toBe(false)
    })

    test("does not hold when holdInInbox is false, even crossing another user's message", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const reader = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 1)
      const [evt] = await StreamEventRepository.list(pool, sid)

      const { becameHeld, state } = await ReadStateRepository.advance(pool, sid, reader, evt.id, {
        holdInInbox: false,
      })

      expect(becameHeld).toBe(false)
      expect(state?.inboxHeld).toBe(false)
    })

    test("reports becameHeld false on a later advance that finds the stream already held", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      const reader = userId()
      await seedChannel(wid, sid, author)
      await sendMessages(wid, sid, author, 2)
      const [evt1, evt2] = await StreamEventRepository.list(pool, sid)

      const first = await ReadStateRepository.advance(pool, sid, reader, evt1.id, { holdInInbox: true })
      expect(first.becameHeld).toBe(true)

      const second = await ReadStateRepository.advance(pool, sid, reader, evt2.id, { holdInInbox: true })
      expect(second.becameHeld).toBe(false)
      expect(second.state?.inboxHeld).toBe(true)
    })
  })

  describe("ReadStateRepository.batchAdvance", () => {
    test("reports becameHeldStreamIds only for rows that crossed another user's message", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const streamOther = streamId()
      const streamSelf = streamId()
      await seedChannel(wid, streamOther, author)
      await seedChannel(wid, streamSelf, reader)
      await sendMessages(wid, streamOther, author, 1)
      await sendMessages(wid, streamSelf, reader, 1)
      const [evtOther] = await StreamEventRepository.list(pool, streamOther)
      const [evtSelf] = await StreamEventRepository.list(pool, streamSelf)

      const { states, becameHeldStreamIds } = await ReadStateRepository.batchAdvance(
        pool,
        reader,
        new Map([
          [streamOther, evtOther.id],
          [streamSelf, evtSelf.id],
        ]),
        { holdInInbox: true }
      )

      expect(becameHeldStreamIds).toEqual([streamOther])
      const byStream = new Map(states.map((s) => [s.streamId, s]))
      expect(byStream.get(streamOther)?.inboxHeld).toBe(true)
      expect(byStream.get(streamSelf)?.inboxHeld).toBe(false)
    })
  })

  describe("EventService.createMessage author-send hold", () => {
    test("holds when the author's send advance crosses another user's unread message", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const other = userId()
      const author = userId()
      await seedChannel(wid, sid, other, "public")
      await sendMessages(wid, sid, other, 1)

      await eventService.createMessage({
        workspaceId: wid,
        streamId: sid,
        authorId: author,
        authorType: "user",
        ...testMessageContent("author's reply"),
      })

      expect((await ReadStateRepository.get(pool, sid, author))?.inboxHeld).toBe(true)
      expect(await outboxFor("stream:inbox_updated")).toEqual([
        {
          workspaceId: wid,
          authorId: author,
          streamIds: [sid],
          held: true,
        },
      ])
    })

    test("does not hold when the author is already caught up before sending", async () => {
      const wid = workspaceId()
      const sid = streamId()
      const author = userId()
      await seedChannel(wid, sid, author, "public")

      await eventService.createMessage({
        workspaceId: wid,
        streamId: sid,
        authorId: author,
        authorType: "user",
        ...testMessageContent("author's own first message"),
      })

      expect((await ReadStateRepository.get(pool, sid, author))?.inboxHeld).toBe(false)
      expect(await outboxFor("stream:inbox_updated")).toEqual([])
    })
  })

  describe("ReadStateRepository.clearInboxHeld", () => {
    test("clears only the streams that were actually held, returning just those ids", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const heldStream = streamId()
      const unheldStream = streamId()
      await seedChannel(wid, heldStream, author)
      await seedChannel(wid, unheldStream, reader)
      await sendMessages(wid, heldStream, author, 1)
      await sendMessages(wid, unheldStream, reader, 1)
      const [evtHeld] = await StreamEventRepository.list(pool, heldStream)
      const [evtUnheld] = await StreamEventRepository.list(pool, unheldStream)

      await ReadStateRepository.advance(pool, heldStream, reader, evtHeld.id, { holdInInbox: true })
      await ReadStateRepository.advance(pool, unheldStream, reader, evtUnheld.id, { holdInInbox: true })

      const cleared = await ReadStateRepository.clearInboxHeld(pool, wid, reader, [heldStream, unheldStream])

      expect(cleared).toEqual([heldStream])
      expect((await ReadStateRepository.get(pool, heldStream, reader))?.inboxHeld).toBe(false)
      expect((await ReadStateRepository.get(pool, unheldStream, reader))?.inboxHeld).toBe(false)
    })

    test("scopes to the given workspace — a same-id-shaped hold in another workspace is untouched", async () => {
      const wid = workspaceId()
      const otherWid = workspaceId()
      const reader = userId()
      const author = userId()
      const sid = streamId()
      const otherWorkspaceStream = streamId()
      await seedChannel(wid, sid, author)
      await seedChannel(otherWid, otherWorkspaceStream, author)
      await sendMessages(wid, sid, author, 1)
      await sendMessages(otherWid, otherWorkspaceStream, author, 1)
      const [evt] = await StreamEventRepository.list(pool, sid)
      const [evtOtherWs] = await StreamEventRepository.list(pool, otherWorkspaceStream)

      await ReadStateRepository.advance(pool, sid, reader, evt.id, { holdInInbox: true })
      await ReadStateRepository.advance(pool, otherWorkspaceStream, reader, evtOtherWs.id, { holdInInbox: true })

      // Scoped to `wid`, so the other workspace's held row for the same
      // reader must survive even though its stream id was passed in.
      const cleared = await ReadStateRepository.clearInboxHeld(pool, wid, reader, [sid, otherWorkspaceStream])

      expect(cleared).toEqual([sid])
      expect((await ReadStateRepository.get(pool, otherWorkspaceStream, reader))?.inboxHeld).toBe(true)
    })
  })

  describe("ReadStateRepository.listInboxHeldStreamIds", () => {
    test("lists exactly this user's held streams in this workspace", async () => {
      const wid = workspaceId()
      const otherWid = workspaceId()
      const author = userId()
      const reader = userId()
      const otherUser = userId()
      const held = streamId()
      const notHeld = streamId()
      const otherWorkspaceStream = streamId()
      await seedChannel(wid, held, author)
      await seedChannel(wid, notHeld, author)
      await seedChannel(otherWid, otherWorkspaceStream, author)
      await sendMessages(wid, held, author, 1)
      await sendMessages(wid, notHeld, author, 1)
      await sendMessages(otherWid, otherWorkspaceStream, author, 1)
      const [evtHeld] = await StreamEventRepository.list(pool, held)
      const [evtNotHeld] = await StreamEventRepository.list(pool, notHeld)
      const [evtOtherWs] = await StreamEventRepository.list(pool, otherWorkspaceStream)

      await ReadStateRepository.advance(pool, held, reader, evtHeld.id, { holdInInbox: true })
      await ReadStateRepository.advance(pool, notHeld, reader, evtNotHeld.id, { holdInInbox: false })
      // A different user's hold in the same workspace must not leak in.
      await ReadStateRepository.advance(pool, held, otherUser, evtHeld.id, { holdInInbox: true })
      // A hold in a different workspace must not leak in either.
      await ReadStateRepository.advance(pool, otherWorkspaceStream, reader, evtOtherWs.id, { holdInInbox: true })

      const result = await ReadStateRepository.listInboxHeldStreamIds(pool, wid, reader)

      expect(result).toEqual([held])
    })
  })

  describe("StreamService.clearInbox", () => {
    test("restricts to accessible streams — a private channel the user can't read is dropped", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const readableStream = streamId()
      const privateStream = streamId()
      await seedChannel(wid, readableStream, author, "public")
      await seedChannel(wid, privateStream, author, "private")
      await sendMessages(wid, readableStream, author, 1)
      await sendMessages(wid, privateStream, author, 1)
      const [evtReadable] = await StreamEventRepository.list(pool, readableStream)
      const [evtPrivate] = await StreamEventRepository.list(pool, privateStream)

      await ReadStateRepository.advance(pool, readableStream, reader, evtReadable.id, { holdInInbox: true })
      await ReadStateRepository.advance(pool, privateStream, reader, evtPrivate.id, { holdInInbox: true })

      const result = await streamService.clearInbox(wid, reader, [readableStream, privateStream])

      expect(result.clearedStreamIds).toEqual([readableStream])
      expect((await ReadStateRepository.get(pool, readableStream, reader))?.inboxHeld).toBe(false)
      // The private stream's hold is untouched — access was never granted.
      expect((await ReadStateRepository.get(pool, privateStream, reader))?.inboxHeld).toBe(true)
    })

    test("clears a thread the reader isn't a member of, nested under a public channel (INV-62)", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const root = streamId()
      const thread = streamId()
      await seedChannel(wid, root, author, "public")
      const [rootMsg] = await sendMessages(wid, root, author, 1)
      // A thread's own visibility is irrelevant — access resolves through
      // `root_stream_id` to the public root, so the reader needs no
      // `stream_members` row on either stream.
      await pool.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
         VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
        [thread, wid, author, root, rootMsg]
      )
      await sendMessages(wid, thread, author, 1)
      const [evtThread] = await StreamEventRepository.list(pool, thread)

      await ReadStateRepository.advance(pool, thread, reader, evtThread.id, { holdInInbox: true })
      expect((await ReadStateRepository.get(pool, thread, reader))?.inboxHeld).toBe(true)

      const result = await streamService.clearInbox(wid, reader, [thread])

      expect(result.clearedStreamIds).toEqual([thread])
      expect((await ReadStateRepository.get(pool, thread, reader))?.inboxHeld).toBe(false)
    })

    test("advances below-latest streams with holdInInbox false — clearing can't create a new hold", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const sid = streamId()
      await seedChannel(wid, sid, author, "public")
      // reader never read this stream — clearInbox must catch it up to latest
      // without pinning a new hold, even though the latest events are all
      // authored by someone else.
      await sendMessages(wid, sid, author, 2)
      const events = await StreamEventRepository.list(pool, sid)

      const result = await streamService.clearInbox(wid, reader, [sid])

      expect(result.frontiers).toEqual([
        expect.objectContaining({ streamId: sid, lastReadEventId: events[1].id }),
      ])
      const row = await ReadStateRepository.get(pool, sid, reader)
      expect(row?.lastReadEventId).toBe(events[1].id)
      expect(row?.inboxHeld).toBe(false)
      // Nothing was held before the call, so nothing is reported cleared.
      expect(result.clearedStreamIds).toEqual([])
    })

    test("clears inbox_held and emits stream:inbox_updated(held: false) only when something was actually cleared", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const heldStream = streamId()
      const alreadyCaughtUpStream = streamId()
      await seedChannel(wid, heldStream, author, "public")
      await seedChannel(wid, alreadyCaughtUpStream, author, "public")
      await sendMessages(wid, heldStream, author, 1)
      await sendMessages(wid, alreadyCaughtUpStream, author, 1)
      const [evtHeld] = await StreamEventRepository.list(pool, heldStream)
      const [evtAlreadyCaughtUp] = await StreamEventRepository.list(pool, alreadyCaughtUpStream)

      await ReadStateRepository.advance(pool, heldStream, reader, evtHeld.id, { holdInInbox: true })
      // Already at the latest event and never held — clearInbox should be a
      // true no-op for this stream.
      await ReadStateRepository.advance(pool, alreadyCaughtUpStream, reader, evtAlreadyCaughtUp.id, {
        holdInInbox: false,
      })

      const result = await streamService.clearInbox(wid, reader, [heldStream, alreadyCaughtUpStream])

      expect(result.clearedStreamIds).toEqual([heldStream])
      const emitted = await outboxFor("stream:inbox_updated")
      expect(emitted).toEqual([
        {
          workspaceId: wid,
          authorId: reader,
          streamIds: [heldStream],
          held: false,
        },
      ])
    })

    test("emits nothing when no accessible stream was held", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const sid = streamId()
      await seedChannel(wid, sid, author, "public")
      await sendMessages(wid, sid, author, 1)

      const result = await streamService.clearInbox(wid, reader, [sid])

      expect(result.clearedStreamIds).toEqual([])
      expect(await outboxFor("stream:inbox_updated")).toEqual([])
    })

    test("returns empty results without querying when no candidate stream is accessible", async () => {
      const wid = workspaceId()
      const result = await streamService.clearInbox(wid, userId(), ["stream_does_not_exist"])
      expect(result).toEqual({ clearedStreamIds: [], frontiers: [] })
    })
  })

  describe("markAllAsRead emits stream:inbox_updated when a stream becomes held", () => {
    test("holding on mark-all: crossing another user's message sets inbox_held and emits the event", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const sid = streamId()
      await seedChannel(wid, sid, author, "public")
      await sendMessages(wid, sid, author, 1)
      await StreamMemberRepository.insert(pool, sid, reader)

      const result = await streamService.markAllAsRead(wid, reader)

      expect(result.updatedStreamIds).toEqual([sid])
      expect((await ReadStateRepository.get(pool, sid, reader))?.inboxHeld).toBe(true)
      expect(await outboxFor("stream:inbox_updated")).toEqual([
        {
          workspaceId: wid,
          authorId: reader,
          streamIds: [sid],
          held: true,
        },
      ])
    })
  })

  describe("clearInbox + ActivityService.markStreamsAsRead composition (the workspace handler's pairing)", () => {
    test("marks a stream's unread mention read when clearInbox advances its frontier", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const sid = streamId()
      await seedChannel(wid, sid, author, "public")
      const [msgId] = await sendMessages(wid, sid, author, 1)
      await ActivityRepository.insert(pool, {
        workspaceId: wid,
        userId: reader,
        activityType: ActivityTypes.MENTION,
        streamId: sid,
        messageId: msgId,
        actorId: author,
        actorType: "user",
      })

      const { frontiers } = await streamService.clearInbox(wid, reader, [sid])
      expect(frontiers).toEqual([expect.objectContaining({ streamId: sid })])

      // Mirrors createWorkspaceHandlers().clearInbox: activity clears for every
      // stream whose frontier actually advanced.
      await activityService.markStreamsAsRead(
        reader,
        wid,
        frontiers.map((f) => f.streamId)
      )

      const row = await pool.query<{ read_at: Date | null }>(
        `SELECT read_at FROM user_activity WHERE workspace_id = $1 AND user_id = $2 AND stream_id = $3`,
        [wid, reader, sid]
      )
      expect(row.rows[0]?.read_at).not.toBeNull()
    })

    test("leaves activity untouched for a stream whose frontier did not advance", async () => {
      const wid = workspaceId()
      const author = userId()
      const reader = userId()
      const sid = streamId()
      await seedChannel(wid, sid, author, "public")
      const [msgId] = await sendMessages(wid, sid, author, 1)
      const [evt] = await StreamEventRepository.list(pool, sid)
      // Reader is already caught up before clearInbox runs — no advance.
      await ReadStateRepository.advance(pool, sid, reader, evt.id, { holdInInbox: false })
      const activity = await ActivityRepository.insert(pool, {
        workspaceId: wid,
        userId: reader,
        activityType: ActivityTypes.MENTION,
        streamId: sid,
        messageId: msgId,
        actorId: author,
        actorType: "user",
      })

      const { frontiers } = await streamService.clearInbox(wid, reader, [sid])
      expect(frontiers).toEqual([])

      const row = await pool.query<{ read_at: Date | null }>(`SELECT read_at FROM user_activity WHERE id = $1`, [
        activity?.id,
      ])
      expect(row.rows[0]?.read_at).toBeNull()
    })
  })
})
