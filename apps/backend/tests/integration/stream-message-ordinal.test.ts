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
    const result = await pool.query<{ stream_id: string; stored: number | null; counted: number }>(
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

  async function setStoredOrdinal(wsId: string, sid: string, value: number | null) {
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

  test("should leave an uncounted stream uncounted through a send until the backfill counts it", async () => {
    const { wsId, sid, actorId } = await setup()
    await send(wsId, sid, actorId)
    await setStoredOrdinal(wsId, sid, null)
    await send(wsId, sid, actorId)
    const beforeBackfill = await ordinals(wsId, [sid])

    const processed = await runBackfill(wsId)

    expect({ beforeBackfill, processed, afterBackfill: await ordinals(wsId, [sid]) }).toEqual({
      beforeBackfill: { [sid]: { stored: null, counted: 2 } },
      processed: 1,
      afterBackfill: { [sid]: { stored: 2, counted: 2 } },
    })
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
    await setStoredOrdinal(wsId, sid, null)

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
