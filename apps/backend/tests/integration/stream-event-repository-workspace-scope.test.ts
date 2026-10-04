import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { EventService } from "../../src/features/messaging"
import {
  SparseReadRepository,
  StreamEventRepository,
  StreamService,
  type StreamEvent,
} from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { commandId, eventId, messageId, sessionId, userId, workspaceId } from "../../src/lib/id"

describe("StreamEventRepository workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let suffix: string

  let wsA: string
  let wsB: string
  let userA: string
  let channelA: string
  let firstMessageId: string
  let secondMessageId: string
  let agentMessageId: string
  let agentSessionId: string
  let firstEvent: StreamEvent
  let secondEvent: StreamEvent
  let commandEvent: StreamEvent
  let sessionStartedEvent: StreamEvent
  let agentMessageEvent: StreamEvent
  let commandIdA: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    const user = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Event scope ${label}`,
        slug: `event-scope-${label}-${id}`,
        createdBy: userId(),
      })
      return addTestMember(client, id, userId())
    })
    return { id, userId: user.id }
  }

  async function sendMessage(workspace: string, streamId: string, authorId: string, text: string) {
    const message = await eventService.createMessage({
      workspaceId: workspace,
      streamId,
      authorId,
      authorType: "user",
      ...testMessageContent(text),
    })
    return message.id
  }

  async function seedMovable(label: string) {
    const source = await streamService.createChannel({
      workspaceId: wsA,
      slug: `event-scope-${label}-src-${suffix}`,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    const destination = await streamService.createChannel({
      workspaceId: wsA,
      slug: `event-scope-${label}-dst-${suffix}`,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    const movableMessageId = await sendMessage(wsA, source.id, userA, `Movable ${label}`)
    const [event] = await StreamEventRepository.list(pool, wsA, source.id)
    return { sourceId: source.id, destinationId: destination.id, messageId: movableMessageId, event }
  }

  function ids(events: Array<{ id: string }>) {
    return events.map((event) => event.id)
  }

  async function readEventLookups(workspace: string) {
    const [forUpdateMessages, forUpdateSessions] = await withTransaction(pool, async (client) => [
      await StreamEventRepository.findMessageCreatedByMessageIdsForUpdate(client, workspace, channelA, [
        firstMessageId,
        secondMessageId,
      ]),
      await StreamEventRepository.findAgentSessionEventsBySessionIdsForUpdate(client, workspace, channelA, [
        agentSessionId,
      ]),
    ])

    return {
      list: ids(await StreamEventRepository.list(pool, workspace, channelA)),
      listAround: ids(
        (await StreamEventRepository.listAround(pool, workspace, channelA, secondEvent.sequence, { limit: 4 })).events
      ),
      findById: (await StreamEventRepository.findById(pool, workspace, firstEvent.id))?.id ?? null,
      findCommandTerminal:
        (await StreamEventRepository.findCommandTerminal(pool, workspace, channelA, commandIdA))?.id ?? null,
      findFirstMessageOnOrAfter:
        (await StreamEventRepository.findFirstMessageOnOrAfter(pool, workspace, channelA, new Date(0)))?.id ?? null,
      findByMessageId:
        (await StreamEventRepository.findByMessageId(pool, workspace, channelA, secondMessageId))?.id ?? null,
      findEarliestMessageEvent:
        (
          await StreamEventRepository.findEarliestMessageEvent(pool, workspace, channelA, [
            secondMessageId,
            firstMessageId,
          ])
        )?.id ?? null,
      findPreviousMessageEvent:
        (await StreamEventRepository.findPreviousMessageEvent(pool, workspace, channelA, secondEvent.sequence))?.id ??
        null,
      findMessageCreatedByMessageIdsForUpdate: ids(forUpdateMessages),
      findAgentSessionEventsBySessionIdsForUpdate: ids(forUpdateSessions),
      getLatestSequence: await StreamEventRepository.getLatestSequence(pool, workspace, channelA),
      getLatestUnseenUserMessage: await StreamEventRepository.getLatestUnseenUserMessage(
        pool,
        workspace,
        channelA,
        firstEvent.sequence
      ),
      getMessageSequence: await StreamEventRepository.getMessageSequence(pool, workspace, channelA, secondMessageId),
      listMessageIdsBySession: await StreamEventRepository.listMessageIdsBySession(
        pool,
        workspace,
        channelA,
        agentSessionId
      ),
      listRerunContextBySessionIds: Object.fromEntries(
        await StreamEventRepository.listRerunContextBySessionIds(pool, workspace, channelA, [agentSessionId])
      ),
    }
  }

  async function readCounts(workspace: string) {
    return {
      countMessagesByStreamBatch: Object.fromEntries(
        await StreamEventRepository.countMessagesByStreamBatch(pool, workspace, [channelA])
      ),
      countUnreadByStreamBatch: Object.fromEntries(
        await StreamEventRepository.countUnreadByStreamBatch(pool, workspace, [
          { streamId: channelA, memberId: userA, lastReadEventId: firstEvent.id },
        ])
      ),
      countMessagesThroughBatch: Object.fromEntries(
        await StreamEventRepository.countMessagesThroughBatch(
          pool,
          workspace,
          new Map([[channelA, secondEvent.sequence.toString()]])
        )
      ),
      countMessagesThrough: await StreamEventRepository.countMessagesThrough(
        pool,
        workspace,
        channelA,
        secondEvent.sequence
      ),
      getMessageOrdinalForEvent: await StreamEventRepository.getMessageOrdinalForEvent(
        pool,
        workspace,
        channelA,
        secondEvent.id
      ),
      getSequencesByEventIds: Object.fromEntries(
        await StreamEventRepository.getSequencesByEventIds(pool, workspace, [firstEvent.id, secondEvent.id])
      ),
      getLatestEventIdByStreamBatch: Object.fromEntries(
        await StreamEventRepository.getLatestEventIdByStreamBatch(pool, workspace, [channelA])
      ),
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    suffix = Math.random().toString(36).slice(2, 8)

    const a = await seedWorkspace("a")
    const b = await seedWorkspace("b")
    wsA = a.id
    wsB = b.id
    userA = a.userId

    const channel = await streamService.createChannel({
      workspaceId: wsA,
      slug: `event-scope-alpha-${suffix}`,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    channelA = channel.id

    firstMessageId = await sendMessage(wsA, channelA, userA, "First")
    secondMessageId = await sendMessage(wsA, channelA, userA, "Second")

    commandIdA = commandId()
    agentSessionId = sessionId()
    agentMessageId = messageId()
    commandEvent = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsA,
      streamId: channelA,
      eventType: "command_completed",
      payload: { commandId: commandIdA },
      actorId: userA,
      actorType: AuthorTypes.USER,
    })
    sessionStartedEvent = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsA,
      streamId: channelA,
      eventType: "agent_session:started",
      payload: {
        sessionId: agentSessionId,
        rerunContext: {
          cause: "invoking_message_edited",
          editedMessageId: firstMessageId,
          editedMessageRevision: 2,
          editedMessageBefore: "First",
          editedMessageAfter: "First, edited",
        },
      },
      actorId: "persona_scope",
      actorType: AuthorTypes.PERSONA,
    })
    agentMessageEvent = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsA,
      streamId: channelA,
      eventType: "message_created",
      payload: { messageId: agentMessageId, sessionId: agentSessionId },
      actorId: "persona_scope",
      actorType: AuthorTypes.PERSONA,
    })

    const messageEvents = (await StreamEventRepository.list(pool, wsA, channelA)).filter(
      (event) => event.eventType === "message_created"
    )
    firstEvent = messageEvents[0]
    secondEvent = messageEvents[1]
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should find an event's lookups only for its own workspace when queried by stream and message ids", async () => {
    expect({
      ownWorkspace: await readEventLookups(wsA),
      otherWorkspace: await readEventLookups(wsB),
    }).toEqual({
      ownWorkspace: {
        list: [firstEvent.id, secondEvent.id, commandEvent.id, sessionStartedEvent.id, agentMessageEvent.id],
        listAround: [firstEvent.id, secondEvent.id, commandEvent.id, sessionStartedEvent.id],
        findById: firstEvent.id,
        findCommandTerminal: commandEvent.id,
        findFirstMessageOnOrAfter: firstEvent.id,
        findByMessageId: secondEvent.id,
        findEarliestMessageEvent: firstEvent.id,
        findPreviousMessageEvent: firstEvent.id,
        findMessageCreatedByMessageIdsForUpdate: [firstEvent.id, secondEvent.id],
        findAgentSessionEventsBySessionIdsForUpdate: [sessionStartedEvent.id],
        getLatestSequence: agentMessageEvent.sequence,
        getLatestUnseenUserMessage: { messageId: secondMessageId, authorId: userA, sequence: secondEvent.sequence },
        getMessageSequence: secondEvent.sequence,
        listMessageIdsBySession: [agentMessageId],
        listRerunContextBySessionIds: {
          [agentSessionId]: {
            cause: "invoking_message_edited",
            editedMessageId: firstMessageId,
            editedMessageRevision: 2,
            editedMessageBefore: "First",
            editedMessageAfter: "First, edited",
          },
        },
      },
      otherWorkspace: {
        list: [],
        listAround: [],
        findById: null,
        findCommandTerminal: null,
        findFirstMessageOnOrAfter: null,
        findByMessageId: null,
        findEarliestMessageEvent: null,
        findPreviousMessageEvent: null,
        findMessageCreatedByMessageIdsForUpdate: [],
        findAgentSessionEventsBySessionIdsForUpdate: [],
        getLatestSequence: null,
        getLatestUnseenUserMessage: null,
        getMessageSequence: null,
        listMessageIdsBySession: [],
        listRerunContextBySessionIds: {},
      },
    })
  })

  test("should count events only for its own workspace when counting messages, unread and ordinals", async () => {
    expect({
      ownWorkspace: await readCounts(wsA),
      otherWorkspace: await readCounts(wsB),
    }).toEqual({
      ownWorkspace: {
        countMessagesByStreamBatch: { [channelA]: 3 },
        countUnreadByStreamBatch: { [channelA]: { unreadCount: 2, totalCount: 3 } },
        countMessagesThroughBatch: { [channelA]: 2 },
        countMessagesThrough: 2,
        getMessageOrdinalForEvent: { sequence: secondEvent.sequence, messageOrdinal: 2 },
        getSequencesByEventIds: {
          [firstEvent.id]: firstEvent.sequence.toString(),
          [secondEvent.id]: secondEvent.sequence.toString(),
        },
        getLatestEventIdByStreamBatch: { [channelA]: agentMessageEvent.id },
      },
      otherWorkspace: {
        countMessagesByStreamBatch: {},
        countUnreadByStreamBatch: { [channelA]: { unreadCount: 0, totalCount: 0 } },
        countMessagesThroughBatch: {},
        countMessagesThrough: 0,
        getMessageOrdinalForEvent: null,
        getSequencesByEventIds: {},
        getLatestEventIdByStreamBatch: {},
      },
    })
  })

  test("should ignore another workspace's events and read overlay in the same stream when counting unread", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsA,
      slug: `event-scope-decoy-${suffix}`,
      createdBy: userA,
      visibility: Visibilities.PUBLIC,
    })
    await sendMessage(wsA, channel.id, userA, "One")
    await sendMessage(wsA, channel.id, userA, "Two")
    const [first] = await StreamEventRepository.list(pool, wsA, channel.id)
    const decoyMessageId = messageId()
    // Above both of A's messages, so a watermark lookup without workspace_id reads every A event as read.
    await StreamEventRepository.allocateSequences(pool, wsB, channel.id, { total: 2, broadcast: 0 })
    const decoy = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsB,
      streamId: channel.id,
      eventType: "message_created",
      payload: { messageId: decoyMessageId },
      actorId: userA,
      actorType: AuthorTypes.USER,
    })
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsB,
      streamId: channel.id,
      memberId: userA,
      messageIds: [decoyMessageId],
    })

    const unread = async (lastReadEventId: string) =>
      (
        await StreamEventRepository.countUnreadByStreamBatch(pool, wsA, [
          { streamId: channel.id, memberId: userA, lastReadEventId },
        ])
      ).get(channel.id)

    expect({
      readThroughFirst: await unread(first.id),
      readThroughDecoy: await unread(decoy.id),
    }).toEqual({
      readThroughFirst: { unreadCount: 1, totalCount: 2 },
      readThroughDecoy: { unreadCount: 2, totalCount: 2 },
    })
  })

  test("should leave the events in place when moveMessageCreatedEvents runs for another workspace", async () => {
    const { sourceId, destinationId, messageId: movableMessageId, event } = await seedMovable("move-messages")

    const moved = await withTransaction(pool, (client) =>
      StreamEventRepository.moveMessageCreatedEvents(client, wsB, {
        sourceStreamId: sourceId,
        destinationStreamId: destinationId,
        updates: [{ messageId: movableMessageId, sequence: 1n, broadcastSequence: 1n }],
        movedFrom: {
          sourceStreamSlug: null,
          sourceStreamDisplayName: null,
          movedAt: new Date().toISOString(),
          movedBy: userA,
          movedByType: AuthorTypes.USER,
          moveTombstoneId: eventId(),
        },
      })
    )

    expect({
      moved,
      source: await StreamEventRepository.list(pool, wsA, sourceId),
      destination: await StreamEventRepository.list(pool, wsA, destinationId),
    }).toEqual({ moved: [], source: [event], destination: [] })
  })

  test("should leave the events in place when moveEventsById runs for another workspace", async () => {
    const { sourceId, destinationId, event } = await seedMovable("move-by-id")

    const moved = await withTransaction(pool, (client) =>
      StreamEventRepository.moveEventsById(client, wsB, {
        sourceStreamId: sourceId,
        destinationStreamId: destinationId,
        updates: [{ eventId: event.id, sequence: 1n, broadcastSequence: 1n }],
      })
    )

    expect({
      moved,
      source: await StreamEventRepository.list(pool, wsA, sourceId),
      destination: await StreamEventRepository.list(pool, wsA, destinationId),
    }).toEqual({ moved: [], source: [event], destination: [] })
  })
})
