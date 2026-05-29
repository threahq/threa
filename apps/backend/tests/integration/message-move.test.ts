import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { EventService } from "../../src/features/messaging"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { StreamEventRepository, StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { eventId, messageId, personaId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent } from "./setup"

describe("message move integration", () => {
  let pool: Pool
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_session_steps")
    await pool.query("DELETE FROM agent_sessions")
    await pool.query("DELETE FROM stream_persona_participants")
    await pool.query("DELETE FROM stream_members")
    await pool.query("DELETE FROM reactions")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM streams")
    await pool.query(
      "DELETE FROM outbox WHERE id > (SELECT COALESCE(MAX(last_processed_id), 0) FROM outbox_listeners WHERE listener_id = 'broadcast')"
    )
  })

  test("moves sparse messages and their agent session traces into a direct child thread", async () => {
    const testWorkspaceId = workspaceId()
    const sourceStreamId = streamId()
    const actorWorkosId = userId()
    const actor = await addTestMember(pool, testWorkspaceId, actorWorkosId)

    await StreamRepository.insert(pool, {
      id: sourceStreamId,
      workspaceId: testWorkspaceId,
      type: "scratchpad",
      visibility: "private",
      companionMode: "on",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, sourceStreamId, actor.id)

    // Claim the stream's single RUNNING agent-session slot *before* any user
    // message exists. The integration suite preloads a live server
    // (tests/setup.ts) whose companion worker polls this same database, and a
    // companion-on scratchpad dispatches a persona-agent job for every USER
    // message. That worker's `insertRunningOrSkip` would otherwise race this
    // test's plain `insert` on `idx_agent_sessions_one_running_per_stream`
    // (23505, flaky). With the slot already held, `CompanionHandler`
    // suppresses the dispatch (it skips while a session is RUNNING) and any
    // job that did dispatch no-ops in `insertRunningOrSkip` — so no second
    // running session, and no stub response leaks onto the stream. The
    // `triggerMessageId` is a placeholder; nothing reads the session's
    // `trigger_message_id`, and the started-event payload below still records
    // the real `target.id`.
    const traceSession = await AgentSessionRepository.insert(pool, {
      id: sessionId(),
      streamId: sourceStreamId,
      personaId: personaId(),
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
    })

    const target = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "user",
      ...testMessageContent("target"),
    })
    const keep = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "user",
      ...testMessageContent("keep"),
    })
    const movedA = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "persona",
      ...testMessageContent("moved a"),
    })
    const movedB = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "persona",
      ...testMessageContent("moved b"),
    })

    const traceStartedEventId = eventId()
    await StreamEventRepository.insert(pool, {
      id: traceStartedEventId,
      streamId: sourceStreamId,
      eventType: "agent_session:started",
      payload: {
        sessionId: traceSession.id,
        personaId: traceSession.personaId,
        personaName: "Ariadne",
        triggerMessageId: target.id,
        startedAt: traceSession.createdAt.toISOString(),
      },
      actorId: traceSession.personaId,
      actorType: "persona",
    })
    await AgentSessionRepository.completeSession(pool, traceSession.id, {
      lastSeenSequence: movedB.sequence,
      responseMessageId: movedB.id,
      sentMessageIds: [movedA.id, movedB.id],
    })
    const traceCompletedEventId = eventId()
    await StreamEventRepository.insert(pool, {
      id: traceCompletedEventId,
      streamId: sourceStreamId,
      eventType: "agent_session:completed",
      payload: {
        sessionId: traceSession.id,
        stepCount: 0,
        messageCount: 2,
        duration: 100,
        completedAt: new Date().toISOString(),
      },
      actorId: traceSession.personaId,
      actorType: "persona",
    })

    const validation = await eventService.validateMoveMessagesToThread({
      workspaceId: testWorkspaceId,
      sourceStreamId,
      targetMessageId: target.id,
      messageIds: [movedB.id, movedA.id],
      actorId: actor.id,
    })

    const result = await eventService.moveMessagesToThread({
      workspaceId: testWorkspaceId,
      sourceStreamId,
      targetMessageId: target.id,
      messageIds: [movedB.id, movedA.id],
      actorId: actor.id,
      leaseKey: validation.leaseKey,
    })

    expect(result.thread.parentStreamId).toBe(sourceStreamId)
    expect(result.thread.parentMessageId).toBe(target.id)
    expect(result.thread.rootStreamId).toBe(sourceStreamId)
    expect(result.thread.companionMode).toBe("on")

    const sourceEvents = await StreamEventRepository.list(pool, sourceStreamId, { types: ["message_created"] })
    const sourceMessageIds = sourceEvents.map((event) => (event.payload as { messageId: string }).messageId)
    expect(sourceMessageIds).toEqual([target.id, keep.id])

    const threadEvents = await StreamEventRepository.list(pool, result.thread.id, { types: ["message_created"] })
    const threadMessageIds = threadEvents.map((event) => (event.payload as { messageId: string }).messageId)
    expect(threadMessageIds).toEqual([movedA.id, movedB.id])

    const movedTraceSession = await AgentSessionRepository.findById(pool, traceSession.id)
    expect(movedTraceSession?.streamId).toBe(result.thread.id)
    expect(result.removedEventIds).toEqual(expect.arrayContaining([traceStartedEventId, traceCompletedEventId]))

    const sourceTraceEvents = await StreamEventRepository.list(pool, sourceStreamId, {
      types: ["agent_session:started", "agent_session:completed"],
    })
    const sourceTraceEventIds = sourceTraceEvents.map((event) => event.id)
    // INV-23: assert the specific trace events are absent from source rather
    // than coupling to a count, so unrelated trace events on this stream don't
    // break the test in the future.
    expect(sourceTraceEventIds).not.toContain(traceStartedEventId)
    expect(sourceTraceEventIds).not.toContain(traceCompletedEventId)

    const threadTraceEvents = await StreamEventRepository.list(pool, result.thread.id, {
      types: ["agent_session:started", "agent_session:completed"],
    })
    expect(threadTraceEvents.map((event) => event.eventType)).toEqual([
      "agent_session:started",
      "agent_session:completed",
    ])

    // Tombstone is inserted into BOTH streams so each side keeps a clickable
    // trace of the move. The renderer collapses each row to "Actor moved N
    // messages" + a drill-in drawer; this assertion locks in the wire shape
    // (per-message previews + stream metadata) the drawer depends on.
    // Find by id rather than asserting count (INV-23) — future test setup
    // could add a second move call without breaking these assertions.
    const sourceTombstoneRows = await StreamEventRepository.list(pool, sourceStreamId, {
      types: ["messages:moved"],
    })
    const sourceTombstone = sourceTombstoneRows.find((event) => event.id === result.sourceTombstoneEvent.id)
    expect(sourceTombstone).toBeDefined()
    if (!sourceTombstone) throw new Error("unreachable")
    expect(sourceTombstone.actorId).toBe(actor.id)
    expect(sourceTombstone.actorType).toBe("user")
    const sourceTombstonePayload = sourceTombstone.payload as {
      sourceStreamId: string
      destinationStreamId: string
      messages: Array<{ id: string; authorId: string | null; contentMarkdown: string }>
    }
    expect(sourceTombstonePayload.sourceStreamId).toBe(sourceStreamId)
    expect(sourceTombstonePayload.destinationStreamId).toBe(result.thread.id)
    // Order is by source-stream sequence (chronological), not the order the
    // user happened to click checkboxes in. The validate request above
    // passed `[movedB, movedA]` deliberately to verify this.
    expect(sourceTombstonePayload.messages.map((message) => message.id)).toEqual([movedA.id, movedB.id])

    const destinationTombstoneRows = await StreamEventRepository.list(pool, result.thread.id, {
      types: ["messages:moved"],
    })
    const destinationTombstone = destinationTombstoneRows.find(
      (event) => (event.payload as { destinationStreamId: string }).destinationStreamId === result.thread.id
    )
    expect(destinationTombstone).toBeDefined()
    expect(destinationTombstone?.payload).toEqual(sourceTombstonePayload)

    // The outbox payload carries the source tombstone separately so source
    // clients can append it after applying `removedEventIds` (the tombstone
    // is NOT in `events`, which is the destination-side write set).
    expect(result.sourceTombstoneEvent.streamId).toBe(sourceStreamId)
    expect(result.events.find((event) => event.id === destinationTombstone?.id)).toBeDefined()
    expect(result.removedEventIds).not.toContain(sourceTombstone.id)

    // Relocated `message_created` payloads carry `movedFrom` provenance so
    // the destination timeline can show a per-message origin badge without
    // joining a separate provenance table. Locks in the full provenance
    // shape — including the snapshotted source slug/displayName the
    // tooltip depends on, and the explicit movedByType.
    const relocatedMessageCreated = await StreamEventRepository.list(pool, result.thread.id, {
      types: ["message_created"],
    })
    for (const event of relocatedMessageCreated) {
      const payload = event.payload as {
        movedFrom?: {
          sourceStreamId: string
          sourceStreamSlug: string | null
          sourceStreamDisplayName: string | null
          movedAt: string
          movedBy: string
          movedByType: string
          moveTombstoneId: string
        }
      }
      expect(payload.movedFrom?.sourceStreamId).toBe(sourceStreamId)
      expect(payload.movedFrom?.sourceStreamSlug).toBe(null)
      expect(payload.movedFrom?.sourceStreamDisplayName).toBe(null)
      expect(payload.movedFrom?.movedBy).toBe(actor.id)
      expect(payload.movedFrom?.movedByType).toBe("user")
      expect(typeof payload.movedFrom?.movedAt).toBe("string")
      // `moveTombstoneId` points at the destination-side tombstone so the
      // per-message context-menu drill-in can fetch it from IDB.
      expect(payload.movedFrom?.moveTombstoneId).toBe(destinationTombstone?.id)
    }
  })

  test("rejects moving a message onto a following message", async () => {
    const testWorkspaceId = workspaceId()
    const sourceStreamId = streamId()
    const actor = await addTestMember(pool, testWorkspaceId, userId())

    await StreamRepository.insert(pool, {
      id: sourceStreamId,
      workspaceId: testWorkspaceId,
      type: "scratchpad",
      visibility: "private",
      companionMode: "off",
      createdBy: actor.id,
    })
    await StreamMemberRepository.insert(pool, sourceStreamId, actor.id)

    const selected = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "user",
      ...testMessageContent("selected"),
    })
    const following = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: sourceStreamId,
      authorId: actor.id,
      authorType: "user",
      ...testMessageContent("following"),
    })

    await expect(
      eventService.validateMoveMessagesToThread({
        workspaceId: testWorkspaceId,
        sourceStreamId,
        targetMessageId: following.id,
        messageIds: [selected.id],
        actorId: actor.id,
      })
    ).rejects.toThrow("Messages can only be moved onto a preceding message")
  })
})
