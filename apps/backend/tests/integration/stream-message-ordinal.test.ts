import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { BridgeMessage } from "@threahq/types"
import { addTestMember, setupTestDatabase, testContentJson, testMessageContent, withTransaction } from "./setup"
import { StreamEventRepository, StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { plan, processChunk } from "../../src/features/streams/message-ordinal-backfill"
import { EventService, applyCopyChanges } from "../../src/features/messaging"
import { eventId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("stream_sequences.message_ordinal", () => {
  let pool: Pool
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(() => {
    mock.restore()
  })

  async function setup() {
    const wsId = workspaceId()
    const sid = streamId()
    const actor = await addTestMember(pool, wsId, userId())
    await StreamRepository.insert(pool, {
      id: sid,
      workspaceId: wsId,
      type: "channel",
      visibility: "private",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, wsId, sid, actor.id)
    return { wsId, sid, actorId: actor.id }
  }

  function send(wsId: string, sid: string, authorId: string, text = "hello") {
    return eventService.createMessage({
      workspaceId: wsId,
      streamId: sid,
      authorId,
      authorType: "user",
      ...testMessageContent(text),
    })
  }

  /** Each stream's stored message ordinal next to its actual message_created count. */
  async function ordinals(wsId: string, streamIds: string[]) {
    const result = await pool.query<{ stream_id: string; stored: number; counted: number }>(
      `SELECT q.stream_id, q.message_ordinal AS stored,
              (SELECT COUNT(*)::int FROM stream_events e
               WHERE e.workspace_id = q.workspace_id AND e.stream_id = q.stream_id
                 AND e.event_type = 'message_created') AS counted
       FROM stream_sequences q
       WHERE q.workspace_id = $1 AND q.stream_id = ANY($2::text[])`,
      [wsId, streamIds]
    )
    return Object.fromEntries(result.rows.map((row) => [row.stream_id, { stored: row.stored, counted: row.counted }]))
  }

  async function runBackfill(wsId: string) {
    let processed = 0
    for (const chunk of await plan({ pool }, wsId)) {
      processed += (await processChunk({ pool }, wsId, chunk)).processed
    }
    return processed
  }

  async function setStoredOrdinal(wsId: string, sid: string, value: number) {
    await pool.query("UPDATE stream_sequences SET message_ordinal = $3 WHERE workspace_id = $1 AND stream_id = $2", [
      wsId,
      sid,
      value,
    ])
  }

  test("should count sends and leave edits, reactions and deletes out of the ordinal", async () => {
    const { wsId, sid, actorId } = await setup()
    const first = await send(wsId, sid, actorId)
    await send(wsId, sid, actorId)
    await eventService.editMessageInternal({
      workspaceId: wsId,
      messageId: first.id,
      streamId: sid,
      actorId,
      ...testMessageContent("edited"),
    })
    await eventService.addReactionInternal({
      workspaceId: wsId,
      messageId: first.id,
      streamId: sid,
      emoji: "👍",
      userId: actorId,
    })
    await eventService.deleteMessageInternal({ workspaceId: wsId, messageId: first.id, streamId: sid, actorId })

    expect(await ordinals(wsId, [sid])).toEqual({ [sid]: { stored: 2, counted: 2 } })
  })

  test("should count only the message_created events of a mixed insertMany", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    const event = (eventType: "message_created" | "message_edited" | "reaction_added") => ({
      id: eventId(),
      workspaceId: wsId,
      streamId: sid,
      eventType,
      payload: { messageId: messageId() },
      actorId,
      actorType: "user" as const,
    })
    await StreamEventRepository.insertMany(pool, [
      event("message_created"),
      event("message_edited"),
      event("message_created"),
      event("reaction_added"),
    ])

    expect(await ordinals(wsId, [sid])).toEqual({ [sid]: { stored: 3, counted: 3 } })
  })

  test("should move the moved messages' count from the source to the destination thread", async () => {
    const { wsId, sid, actorId } = await setup()
    const target = await send(wsId, sid, actorId, "target")
    await send(wsId, sid, actorId, "keep")
    const movedA = await send(wsId, sid, actorId, "moved a")
    const movedB = await send(wsId, sid, actorId, "moved b")

    const move = {
      workspaceId: wsId,
      sourceStreamId: sid,
      targetMessageId: target.id,
      messageIds: [movedA.id, movedB.id],
      actorId,
    }
    const { leaseKey } = await eventService.validateMoveMessagesToThread(move)
    const { thread } = await eventService.moveMessagesToThreadInternal({ ...move, leaseKey })

    expect(await ordinals(wsId, [sid, thread.id])).toEqual({
      [sid]: { stored: 2, counted: 2 },
      [thread.id]: { stored: 2, counted: 2 },
    })
  })

  test("should stay exact when the backfill recounts the source after a move relocated its messages but before it lowered the ordinal", async () => {
    const { wsId, sid, actorId } = await setup()
    const target = await send(wsId, sid, actorId, "target")
    await send(wsId, sid, actorId, "stays")
    const moved = [await send(wsId, sid, actorId, "moved 1"), await send(wsId, sid, actorId, "moved 2")]

    const reachedDecrement = Promise.withResolvers<void>()
    const recounted = Promise.withResolvers<void>()
    const removeFromMessageOrdinal = StreamEventRepository.removeFromMessageOrdinal.bind(StreamEventRepository)
    spyOn(StreamEventRepository, "removeFromMessageOrdinal").mockImplementation(async (...args) => {
      reachedDecrement.resolve()
      await recounted.promise
      return removeFromMessageOrdinal(...args)
    })

    const move = {
      workspaceId: wsId,
      sourceStreamId: sid,
      targetMessageId: target.id,
      messageIds: moved.map((message) => message.id),
      actorId,
    }
    const { leaseKey } = await eventService.validateMoveMessagesToThread(move)
    const moving = eventService.moveMessagesToThreadInternal({ ...move, leaseKey })
    await reachedDecrement.promise
    await withTransaction(pool, (client) => StreamEventRepository.recountMessageOrdinal(client, wsId, sid))
    recounted.resolve()
    const { thread } = await moving

    expect(await ordinals(wsId, [sid, thread.id])).toEqual({
      [sid]: { stored: 2, counted: 2 },
      [thread.id]: { stored: 2, counted: 2 },
    })
  })

  test("should count each Connect copy once when a later pull reapplies it", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    const stream = await StreamRepository.findById(pool, wsId, sid)
    const copy = (text: string): BridgeMessage => ({
      id: messageId(),
      streamId: sid,
      authorId: actorId,
      authorType: "user",
      contentJson: testContentJson(text),
      contentMarkdown: text,
      reactions: {},
      revision: 1,
      editedAt: null,
      createdAt: new Date().toISOString(),
      attachments: [],
      clientMessageId: null,
    })
    const first = copy("first copy")
    const changes = [
      { kind: "message" as const, message: first },
      { kind: "message" as const, message: copy("second copy") },
    ]
    await withTransaction(pool, (client) => applyCopyChanges(client, wsId, stream!, changes, "sconn_test"))
    await withTransaction(pool, (client) =>
      applyCopyChanges(client, wsId, stream!, [{ kind: "message", message: first }], "sconn_test")
    )

    expect(await ordinals(wsId, [sid])).toEqual({ [sid]: { stored: 3, counted: 3 } })
  })

  test("should correct a stale count and change nothing on a rerun", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    await send(wsId, sid, actorId)
    await setStoredOrdinal(wsId, sid, 99)

    const firstRun = await runBackfill(wsId)
    const secondRun = await runBackfill(wsId)

    expect({ firstRun, secondRun, ordinals: await ordinals(wsId, [sid]) }).toEqual({
      firstRun: 1,
      secondRun: 0,
      ordinals: { [sid]: { stored: 2, counted: 2 } },
    })
  })

  test("should include a send that held the sequence row while the backfill waited for it", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    await setStoredOrdinal(wsId, sid, 99)

    const sender = await pool.connect()
    try {
      await sender.query("BEGIN")
      await StreamEventRepository.insert(sender, {
        id: eventId(),
        workspaceId: wsId,
        streamId: sid,
        eventType: "message_created",
        payload: { messageId: messageId() },
        actorId,
        actorType: "user",
      })
      const backfill = runBackfill(wsId)
      await waitForLockWait(pool)
      await sender.query("COMMIT")
      await backfill
    } finally {
      sender.release()
    }

    expect(await ordinals(wsId, [sid])).toEqual({ [sid]: { stored: 2, counted: 2 } })
  })

  describe("readers", () => {
    type EventRow = { id: string; sequence: bigint; eventType: string }
    type SeededStream = { id: string; events: EventRow[]; positions: bigint[] }

    async function eventsOf(wsId: string, sid: string): Promise<EventRow[]> {
      const result = await pool.query<{ id: string; sequence: string; event_type: string }>(
        "SELECT id, sequence, event_type FROM stream_events WHERE workspace_id = $1 AND stream_id = $2 ORDER BY sequence",
        [wsId, sid]
      )
      return result.rows.map((row) => ({ id: row.id, sequence: BigInt(row.sequence), eventType: row.event_type }))
    }

    function bruteForceOrdinal(events: EventRow[], sequence: bigint): number {
      return events.filter((event) => event.eventType === "message_created" && event.sequence <= sequence).length
    }

    function seeded(id: string, events: EventRow[], extraPositions: bigint[] = []): SeededStream {
      const tail = events.at(-1)?.sequence ?? 0n
      return { id, events, positions: [0n, ...events.map((event) => event.sequence), ...extraPositions, tail + 5n] }
    }

    /**
     * An untouched channel, a source channel whose middle messages moved to a
     * thread, the thread, and a stream that never had an event.
     */
    async function seedStreams() {
      const { wsId, sid: sourceId, actorId } = await setup()
      const target = await send(wsId, sourceId, actorId, "target")
      await send(wsId, sourceId, actorId, "stays before")
      const moved = [await send(wsId, sourceId, actorId, "moved 1"), await send(wsId, sourceId, actorId, "moved 2")]
      await send(wsId, sourceId, actorId, "stays after")
      await eventService.addReactionInternal({
        workspaceId: wsId,
        messageId: target.id,
        streamId: sourceId,
        emoji: "👍",
        userId: actorId,
      })
      await send(wsId, sourceId, actorId, "tail")
      const beforeMove = await eventsOf(wsId, sourceId)

      const move = {
        workspaceId: wsId,
        sourceStreamId: sourceId,
        targetMessageId: target.id,
        messageIds: moved.map((message) => message.id),
        actorId,
      }
      const { leaseKey } = await eventService.validateMoveMessagesToThread(move)
      const { thread } = await eventService.moveMessagesToThreadInternal({ ...move, leaseKey })

      const plainId = streamId()
      await StreamRepository.insert(pool, {
        id: plainId,
        workspaceId: wsId,
        type: "channel",
        visibility: "private",
        createdBy: actorId,
      })
      const first = await send(wsId, plainId, actorId, "one")
      await send(wsId, plainId, actorId, "two")
      await eventService.editMessageInternal({
        workspaceId: wsId,
        messageId: first.id,
        streamId: plainId,
        actorId,
        ...testMessageContent("one, edited"),
      })
      await send(wsId, plainId, actorId, "three")

      const sourceEvents = await eventsOf(wsId, sourceId)
      const vacated = beforeMove.filter((event) => !sourceEvents.some((kept) => kept.id === event.id))
      if (vacated.length !== moved.length) throw new Error(`expected the move to vacate ${moved.length} events`)

      return {
        wsId,
        actorId,
        vacatedEventIds: vacated.map((event) => event.id),
        streams: {
          plain: seeded(plainId, await eventsOf(wsId, plainId)),
          source: seeded(
            sourceId,
            sourceEvents,
            vacated.map((event) => event.sequence)
          ),
          thread: seeded(thread.id, await eventsOf(wsId, thread.id)),
          empty: seeded(streamId(), []),
        } satisfies Record<string, SeededStream>,
      }
    }

    test("should match a brute-force count at every position when messages moved out of the source", async () => {
      const { wsId, streams } = await seedStreams()
      const actual: Record<string, number> = {}
      const expected: Record<string, number> = {}
      for (const [label, stream] of Object.entries(streams)) {
        for (const position of stream.positions) {
          const key = `${label}@${position}`
          actual[key] = await StreamEventRepository.countMessagesThrough(pool, wsId, stream.id, position)
          expected[key] = bruteForceOrdinal(stream.events, position)
        }
      }

      expect(actual).toEqual(expected)
    })

    test("should match a brute-force count per stream in a batch when messages moved out of the source", async () => {
      const { wsId, streams } = await seedStreams()
      const rounds = Math.max(...Object.values(streams).map((stream) => stream.positions.length))
      const actual: Array<Record<string, number>> = []
      const expected: Array<Record<string, number>> = []
      for (let round = 0; round < rounds; round++) {
        const sequences = new Map<string, string>()
        const counts: Record<string, number> = {}
        for (const stream of Object.values(streams)) {
          const position = stream.positions[round % stream.positions.length]
          sequences.set(stream.id, position.toString())
          const count = bruteForceOrdinal(stream.events, position)
          if (count > 0) counts[stream.id] = count
        }
        actual.push(Object.fromEntries(await StreamEventRepository.countMessagesThroughBatch(pool, wsId, sequences)))
        expected.push(counts)
      }

      expect(actual).toEqual(expected)
    })

    test("should match a brute-force ordinal for every event and null for missing ones when messages moved out of the source", async () => {
      const { wsId, streams, vacatedEventIds } = await seedStreams()
      const actual: Record<string, { sequence: bigint; messageOrdinal: number } | null> = {}
      const expected: Record<string, { sequence: bigint; messageOrdinal: number } | null> = {}
      for (const [label, stream] of Object.entries(streams)) {
        for (const event of stream.events) {
          const key = `${label}:${event.id}`
          actual[key] = await StreamEventRepository.getMessageOrdinalForEvent(pool, wsId, stream.id, event.id)
          expected[key] = { sequence: event.sequence, messageOrdinal: bruteForceOrdinal(stream.events, event.sequence) }
        }
      }
      for (const id of [...vacatedEventIds, eventId()]) {
        actual[`source:${id}`] = await StreamEventRepository.getMessageOrdinalForEvent(
          pool,
          wsId,
          streams.source.id,
          id
        )
        expected[`source:${id}`] = null
      }

      expect(actual).toEqual(expected)
    })

    test("should match brute-force unread and total counts at every watermark when messages moved out of the source", async () => {
      const { wsId, actorId, streams } = await seedStreams()
      const watermarks = Object.values(streams).map((stream) => [
        { id: null, sequence: 0n },
        { id: eventId(), sequence: 0n },
        ...stream.events.map((event) => ({ id: event.id, sequence: event.sequence })),
      ])
      const rounds = Math.max(...watermarks.map((list) => list.length))
      const actual: Array<Record<string, { unreadCount: number; totalCount: number }>> = []
      const expected: Array<Record<string, { unreadCount: number; totalCount: number }>> = []
      for (let round = 0; round < rounds; round++) {
        const memberships = Object.values(streams).map((stream, index) => {
          const watermark = watermarks[index][round % watermarks[index].length]
          return { stream, watermark }
        })
        const result = await StreamEventRepository.countUnreadByStreamBatch(
          pool,
          wsId,
          memberships.map(({ stream, watermark }) => ({
            streamId: stream.id,
            memberId: actorId,
            lastReadEventId: watermark.id,
          }))
        )
        actual.push(Object.fromEntries(result))
        expected.push(
          Object.fromEntries(
            memberships.map(({ stream, watermark }) => {
              const total = bruteForceOrdinal(stream.events, stream.positions.at(-1)!)
              return [
                stream.id,
                { unreadCount: total - bruteForceOrdinal(stream.events, watermark.sequence), totalCount: total },
              ]
            })
          )
        )
      }

      expect(actual).toEqual(expected)
    })

    test("should keep reporting the same ordinal for a message when sends land above it concurrently", async () => {
      const { wsId, sid, actorId } = await setup()
      await send(wsId, sid, actorId, "first")
      await send(wsId, sid, actorId, "second")
      const second = (await eventsOf(wsId, sid)).at(-1)!

      let sending = true
      const sends = Promise.all(Array.from({ length: 30 }, (_, i) => send(wsId, sid, actorId, `later ${i}`))).finally(
        () => (sending = false)
      )
      const seen = new Set<number | undefined>()
      while (sending) {
        seen.add(await StreamEventRepository.countMessagesThrough(pool, wsId, sid, second.sequence))
        seen.add((await StreamEventRepository.getMessageOrdinalForEvent(pool, wsId, sid, second.id))?.messageOrdinal)
      }
      await sends

      expect([...seen]).toEqual([2])
    })
  })
})

async function waitForLockWait(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query<{ waiting: number }>(
      `SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE '%FROM stream_sequences%FOR UPDATE%'`
    )
    if (result.rows[0].waiting > 0) return
    await Bun.sleep(10)
  }
  throw new Error("backfill never waited on the sequence row lock")
}
