import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { EventService } from "../../src/features/messaging"
import {
  ReadStateRepository,
  SparseReadRepository,
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
  resolveNotificationLevelsForStream,
  usersReadThroughEffective,
} from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { eventId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

interface SeededEvent {
  id: string
  sequence: bigint
  messageId: string
}

describe("Read state and sparse overlay workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService

  let wsA: string
  let wsB: string
  let author: string
  let bAuthor: string
  let channelA: string
  let channelB: string
  let destinationA: string
  let threadA: string
  let reader: string
  let fresh: string
  let e1: { id: string; sequence: bigint }
  let e2: { id: string; sequence: bigint }
  let e3: { id: string; sequence: bigint }
  let m2: string
  let m3: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Read scope ${label}`,
        slug: `read-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => (await addTestMember(client, wid, userId())).id)
  }

  async function seedChannel(wid: string, createdBy: string = author) {
    const channel = await streamService.createChannel({
      workspaceId: wid,
      slug: `read-scope-${Math.random().toString(36).slice(2, 10)}`,
      createdBy,
      visibility: Visibilities.PUBLIC,
    })
    return channel.id
  }

  async function addEvent(wid: string, stream: string, actor: string, message: string = messageId()) {
    const event = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wid,
      streamId: stream,
      eventType: "message_created",
      payload: { messageId: message },
      actorId: actor,
      actorType: "user",
    })
    return { id: event.id, sequence: event.sequence, messageId: message } satisfies SeededEvent
  }

  async function addMessage(wid: string, stream: string, id: string, deleted: boolean) {
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, deleted_at)
       VALUES ($1, $2, $3, 0, $4, 'user', '', '{}', $5)`,
      [id, wid, stream, author, deleted ? new Date() : null]
    )
  }

  async function addReadState(
    wid: string,
    stream: string,
    user: string,
    state: { lastReadEventId?: string; held?: boolean; floorEventId?: string } = {}
  ) {
    await pool.query(
      `INSERT INTO stream_read_state (workspace_id, stream_id, user_id, last_read_event_id, inbox_held, inbox_floor_event_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [wid, stream, user, state.lastReadEventId ?? null, state.held ?? false, state.floorEventId ?? null]
    )
  }

  async function addOverlay(wid: string, stream: string, member: string, event: SeededEvent) {
    await pool.query(
      `INSERT INTO stream_member_message_reads (workspace_id, stream_id, member_id, message_id, event_id, sequence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [wid, stream, member, event.messageId, event.id, event.sequence.toString()]
    )
  }

  async function overlayRow(member: string, message: string) {
    const result = await pool.query(
      `SELECT workspace_id, stream_id, event_id FROM stream_member_message_reads WHERE member_id = $1 AND message_id = $2`,
      [member, message]
    )
    return result.rows[0]
  }

  async function seedCrossStream() {
    const stream = await seedChannel(wsA)
    const a1 = await addEvent(wsA, stream, author)
    const a2 = await addEvent(wsA, stream, author)
    const b1 = await addEvent(wsB, stream, bAuthor)
    return { stream, a1, a2, b1 }
  }

  async function storedState() {
    const readState = await pool.query(
      `SELECT workspace_id, user_id, last_read_event_id, inbox_held, inbox_floor_event_id FROM stream_read_state WHERE stream_id = $1 ORDER BY user_id`,
      [channelA]
    )
    const overlay = await pool.query(
      `SELECT workspace_id, member_id, message_id, stream_id FROM stream_member_message_reads WHERE member_id = $1 ORDER BY message_id`,
      [reader]
    )
    return { readState: readState.rows, overlay: overlay.rows }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    author = await seedMember(wsA)
    bAuthor = await seedMember(wsB)
    channelB = await seedChannel(wsB, bAuthor)
    reader = await seedMember(wsA)
    fresh = await seedMember(wsA)

    channelA = await seedChannel(wsA)
    await StreamMemberRepository.insert(pool, wsA, channelA, reader)
    await StreamMemberRepository.update(pool, wsA, channelA, reader, { notificationLevel: "everything" })

    const messageIds: string[] = []
    for (const text of ["one", "two", "three"]) {
      const message = await eventService.createMessage({
        workspaceId: wsA,
        streamId: channelA,
        authorId: author,
        authorType: "user",
        ...testMessageContent(text),
      })
      messageIds.push(message.id)
    }
    const [m1] = messageIds
    ;[, m2, m3] = messageIds
    await pool.query(`UPDATE messages SET deleted_at = NOW() WHERE workspace_id = $1 AND id = $2`, [wsA, m1])

    const events = await StreamEventRepository.list(pool, wsA, channelA)
    const createdEvent = (messageId: string) => {
      const event = events.find(
        (e) => e.eventType === "message_created" && (e.payload as { messageId: string }).messageId === messageId
      )!
      return { id: event.id, sequence: event.sequence }
    }
    e1 = createdEvent(m1)
    e2 = createdEvent(m2)
    e3 = createdEvent(m3)

    destinationA = await seedChannel(wsA)
    await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsA,
      streamId: destinationA,
      eventType: "message_created",
      payload: { messageId: m3 },
      actorId: author,
      actorType: "user",
    })

    const thread = await streamService.createThread({
      workspaceId: wsA,
      parentStreamId: channelA,
      parentAnchorId: m2,
      createdBy: author,
      principal: { kind: "user", userId: author },
    })
    threadA = thread.id

    await ReadStateRepository.advance(pool, wsA, channelA, reader, e1.id, { holdInInbox: false })
    await ReadStateRepository.advance(pool, wsA, channelA, reader, e2.id, { holdInInbox: true })
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: channelA,
      memberId: reader,
      messageIds: [m3],
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return the read state only for its own workspace when getting by stream and user", async () => {
    expect({
      a: await ReadStateRepository.get(pool, wsA, channelA, reader),
      b: await ReadStateRepository.get(pool, wsB, channelA, reader),
    }).toEqual({
      a: expect.objectContaining({ workspaceId: wsA, streamId: channelA, userId: reader, lastReadEventId: e2.id }),
      b: null,
    })
  })

  test("should return the read state only for its own workspace when getting a batch", async () => {
    expect({
      a: (await ReadStateRepository.getBatch(pool, wsA, reader, [channelA])).map((state) => state.streamId),
      b: await ReadStateRepository.getBatch(pool, wsB, reader, [channelA]),
    }).toEqual({ a: [channelA], b: [] })
  })

  test("should return the inbox arrival only for its own workspace when listing arrivals", async () => {
    expect({
      a: Object.keys(await ReadStateRepository.listInboxArrivals(pool, wsA, reader, [channelA])),
      b: await ReadStateRepository.listInboxArrivals(pool, wsB, reader, [channelA]),
    }).toEqual({ a: [channelA], b: {} })
  })

  test("should report readers only for their own workspace when resolving users read through a sequence", async () => {
    expect({
      a: await usersReadThroughEffective(pool, wsA, channelA, [reader], e2.sequence),
      b: await usersReadThroughEffective(pool, wsB, channelA, [reader], e2.sequence),
    }).toEqual({ a: new Set([reader]), b: new Set() })
  })

  test("should return overlay ids only for their own workspace when listing for a stream", async () => {
    expect({
      a: await SparseReadRepository.listOverlayIds(pool, wsA, channelA, reader),
      b: await SparseReadRepository.listOverlayIds(pool, wsB, channelA, reader),
    }).toEqual({ a: [m3], b: [] })
  })

  test("should return overlay ids only for their own workspace when listing for a member", async () => {
    expect({
      a: Object.fromEntries(await SparseReadRepository.listOverlayIdsForMember(pool, wsA, reader, [channelA])),
      b: Object.fromEntries(await SparseReadRepository.listOverlayIdsForMember(pool, wsB, reader, [channelA])),
    }).toEqual({ a: { [channelA]: [m3] }, b: {} })
  })

  test("should count overlay rows only for their own workspace when counting", async () => {
    expect({
      a: await SparseReadRepository.countOverlay(pool, wsA, channelA, reader),
      b: await SparseReadRepository.countOverlay(pool, wsB, channelA, reader),
    }).toEqual({ a: 1, b: 0 })
  })

  test("should find a compaction target only for its own workspace when probing", async () => {
    expect({
      a: await SparseReadRepository.findCompactionTarget(pool, wsA, channelA, reader, 0n),
      b: await SparseReadRepository.findCompactionTarget(pool, wsB, channelA, reader, 0n),
    }).toEqual({ a: { eventId: e1.id, sequence: e1.sequence }, b: null })
  })

  test("should find a trailing deleted run only for its own workspace when probing", async () => {
    expect({
      a: await SparseReadRepository.findTrailingDeletedRunEnd(pool, wsA, channelA, 0n),
      b: await SparseReadRepository.findTrailingDeletedRunEnd(pool, wsB, channelA, 0n),
    }).toEqual({ a: { eventId: e1.id, sequence: e1.sequence }, b: null })
  })

  test("should inherit notification levels only from its own workspace when resolving ancestors", async () => {
    const thread = (await StreamRepository.findById(pool, wsA, threadA))!
    const members = [{ streamId: threadA, memberId: reader, notificationLevel: null, joinedAt: new Date() }]
    expect({
      a: await resolveNotificationLevelsForStream(pool, thread, members),
      b: await resolveNotificationLevelsForStream(pool, { ...thread, workspaceId: wsB }, members),
    }).toEqual({
      a: [{ memberId: reader, effectiveLevel: "activity", source: "inherited" }],
      b: [{ memberId: reader, effectiveLevel: "activity", source: "default" }],
    })
  })

  const readStateWrites: Array<[string, () => Promise<unknown>]> = [
    ["advancing", () => ReadStateRepository.advance(pool, wsB, channelA, reader, e3.id, { holdInInbox: false })],
    [
      "advancing a user without a read state row",
      () => ReadStateRepository.advance(pool, wsB, channelA, fresh, e3.id, { holdInInbox: false }),
    ],
    ["setting", () => ReadStateRepository.set(pool, wsB, channelA, reader, null)],
    ["batch advancing", () => ReadStateRepository.batchAdvance(pool, wsB, reader, new Map([[channelA, e3.id]]))],
    [
      "batch advancing a user without a read state row",
      () => ReadStateRepository.batchAdvance(pool, wsB, fresh, new Map([[channelA, e3.id]])),
    ],
    ["ensuring for update", () => ReadStateRepository.ensureForUpdate(pool, wsB, channelA, fresh)],
    ["batch ensuring for update", () => ReadStateRepository.ensureBatchForUpdate(pool, wsB, fresh, [channelA])],
    ["setting for users", () => ReadStateRepository.setForUsers(pool, wsB, channelA, [reader, fresh], e3.id)],
    ["clearing the inbox hold", () => ReadStateRepository.clearInboxHeld(pool, wsB, reader, [channelA])],
    ["deleting for a user", () => ReadStateRepository.deleteForUser(pool, wsB, reader)],
    [
      "repointing moved events",
      () =>
        ReadStateRepository.repointForMovedEvents(pool, wsB, channelA, [
          { eventId: e1.id, sequence: e1.sequence },
          { eventId: e2.id, sequence: e2.sequence },
        ]),
    ],
  ]

  for (const [name, write] of readStateWrites) {
    test(`should leave stored read state unchanged when ${name} through another workspace`, async () => {
      const before = await storedState()

      await write()

      expect(await storedState()).toEqual(before)
    })
  }

  const overlayWrites: Array<[string, () => Promise<unknown>]> = [
    [
      "inserting reads",
      () =>
        SparseReadRepository.insertReads(pool, {
          workspaceId: wsB,
          streamId: channelA,
          memberId: reader,
          messageIds: [m2],
        }),
    ],
    ["deleting reads", () => SparseReadRepository.deleteReads(pool, wsB, channelA, reader, [m3])],
    ["pruning at or below", () => SparseReadRepository.pruneAtOrBelow(pool, wsB, channelA, reader, e3.sequence)],
    ["deleting at or above", () => SparseReadRepository.deleteAtOrAbove(pool, wsB, channelA, reader, 0n)],
    ["deleting for streams", () => SparseReadRepository.deleteAllForStreams(pool, wsB, reader, [channelA])],
    [
      "rehoming reads",
      () =>
        SparseReadRepository.rehomeReads(pool, {
          workspaceId: wsB,
          sourceStreamId: channelA,
          destinationStreamId: destinationA,
          messageIds: [m3],
        }),
    ],
  ]

  for (const [name, write] of overlayWrites) {
    test(`should leave the stored overlay unchanged when ${name} through another workspace`, async () => {
      const before = await storedState()

      await write()

      expect(await storedState()).toEqual(before)
    })
  }

  test("should hold and advance from its own workspace's events when the stored watermark points at another workspace's event", async () => {
    const { stream, a2, b1 } = await seedCrossStream()
    const user = userId()
    await addReadState(wsA, stream, user, { lastReadEventId: b1.id })

    expect(await ReadStateRepository.advance(pool, wsA, stream, user, a2.id, { holdInInbox: true })).toEqual({
      state: expect.objectContaining({
        workspaceId: wsA,
        lastReadEventId: a2.id,
        inboxHeld: true,
        inboxFloorEventId: b1.id,
      }),
      held: true,
    })
  })

  test("should keep the watermark when advancing to another workspace's event", async () => {
    const { stream, a1, b1 } = await seedCrossStream()
    const user = userId()
    await addReadState(wsA, stream, user, { lastReadEventId: a1.id })

    expect(await ReadStateRepository.advance(pool, wsA, stream, user, b1.id, { holdInInbox: false })).toEqual({
      state: expect.objectContaining({ workspaceId: wsA, lastReadEventId: a1.id }),
      held: false,
    })
  })

  test("should not hold the stream when only another workspace's event sits in the advanced range", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    await addEvent(wsA, stream, user)
    await addEvent(wsB, stream, bAuthor)
    const own = await addEvent(wsA, stream, user)

    expect(await ReadStateRepository.advance(pool, wsA, stream, user, own.id, { holdInInbox: true })).toEqual({
      state: expect.objectContaining({ workspaceId: wsA, lastReadEventId: own.id, inboxHeld: false }),
      held: false,
    })
  })

  test("should hold the stream when an event references another workspace's deleted message", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    const foreignDeleted = messageId()
    await addMessage(wsB, channelB, foreignDeleted, true)
    const event = await addEvent(wsA, stream, author, foreignDeleted)

    expect(await ReadStateRepository.advance(pool, wsA, stream, user, event.id, { holdInInbox: true })).toEqual({
      state: expect.objectContaining({ workspaceId: wsA, lastReadEventId: event.id, inboxHeld: true }),
      held: true,
    })
  })

  test("should advance to its own workspace's event when batch advancing from a watermark that points at another workspace's event", async () => {
    const { stream, a2, b1 } = await seedCrossStream()
    const user = userId()
    await addReadState(wsA, stream, user, { lastReadEventId: b1.id })

    expect(await ReadStateRepository.batchAdvance(pool, wsA, user, new Map([[stream, a2.id]]))).toEqual({
      states: [expect.objectContaining({ workspaceId: wsA, streamId: stream, lastReadEventId: a2.id })],
    })
  })

  test("should keep the watermark when batch advancing to another workspace's event", async () => {
    const { stream, a1, b1 } = await seedCrossStream()
    const user = userId()
    await addReadState(wsA, stream, user, { lastReadEventId: a1.id })

    expect(await ReadStateRepository.batchAdvance(pool, wsA, user, new Map([[stream, b1.id]]))).toEqual({
      states: [expect.objectContaining({ workspaceId: wsA, streamId: stream, lastReadEventId: a1.id })],
    })
  })

  test("should return no read state when only another workspace holds the row for that stream and user", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    await addReadState(wsB, stream, user)

    expect(await ReadStateRepository.ensureForUpdate(pool, wsA, stream, user)).toBeNull()
  })

  test("should leave another workspace's read state unlocked when batch ensuring for update", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    await addReadState(wsB, stream, user)

    const unlocked = await withTransaction(pool, async (client) => {
      await ReadStateRepository.ensureBatchForUpdate(client, wsA, user, [stream])
      const probe = await pool.query(
        `SELECT user_id FROM stream_read_state WHERE stream_id = $1 AND user_id = $2 FOR UPDATE SKIP LOCKED`,
        [stream, user]
      )
      return probe.rows
    })

    expect(unlocked).toEqual([{ user_id: user }])
  })

  test("should list held streams only from its own workspace when the user is also held in another", async () => {
    const stream = streamId()
    const user = userId()
    await addReadState(wsA, stream, user, { held: true })
    await addReadState(wsB, channelB, user, { held: true })

    expect(await ReadStateRepository.listInboxHeldStreamIds(pool, wsA, user)).toEqual([stream])
  })

  test("should list read states only from its own workspace when the user also has one in another", async () => {
    const stream = streamId()
    const user = userId()
    await addReadState(wsA, stream, user)
    await addReadState(wsB, channelB, user)

    expect(await ReadStateRepository.listForUser(pool, wsA, user)).toEqual([
      expect.objectContaining({ workspaceId: wsA, streamId: stream, userId: user }),
    ])
  })

  test("should clear held streams only in its own workspace when another workspace holds the same user", async () => {
    const stream = streamId()
    const user = userId()
    await addReadState(wsA, stream, user, { held: true })
    await addReadState(wsB, channelB, user, { held: true })

    expect({
      cleared: await ReadStateRepository.clearInboxHeld(pool, wsA, user, [stream, channelB]),
      foreignHeld: await ReadStateRepository.listInboxHeldStreamIds(pool, wsB, user),
    }).toEqual({ cleared: [stream], foreignHeld: [channelB] })
  })

  test("should delete read states only from its own workspace when deleting for a user", async () => {
    const stream = streamId()
    const user = userId()
    await addReadState(wsA, stream, user)
    await addReadState(wsB, channelB, user)

    await ReadStateRepository.deleteForUser(pool, wsA, user)

    expect({
      own: await ReadStateRepository.listForUser(pool, wsA, user),
      foreign: (await ReadStateRepository.listForUser(pool, wsB, user)).map((state) => state.streamId),
    }).toEqual({ own: [], foreign: [channelB] })
  })

  test("should delete read states only from its own workspace when deleting for a workspace", async () => {
    const isolatedWorkspace = workspaceId()
    const user = userId()
    await addReadState(isolatedWorkspace, streamId(), user)
    await addReadState(wsB, channelB, user)

    await ReadStateRepository.deleteForWorkspace(pool, isolatedWorkspace)

    expect({
      own: await ReadStateRepository.listForUser(pool, isolatedWorkspace, user),
      foreign: (await ReadStateRepository.listForUser(pool, wsB, user)).map((state) => state.streamId),
    }).toEqual({ own: [], foreign: [channelB] })
  })

  test("should list inbox arrivals from its own workspace's rows when another workspace's rows share the streams", async () => {
    const user = userId()

    const foreignReadState = await seedChannel(wsA)
    const own = await addEvent(wsA, foreignReadState, author)
    await addReadState(wsB, foreignReadState, user, { lastReadEventId: own.id })

    const foreignFloor = await seedChannel(wsA)
    await addEvent(wsA, foreignFloor, author)
    const foreignFloorEvent = await addEvent(wsB, foreignFloor, bAuthor)
    await addReadState(wsA, foreignFloor, user, { lastReadEventId: foreignFloorEvent.id })

    const foreignDeleted = await seedChannel(wsA)
    const deletedMessage = messageId()
    await addMessage(wsB, channelB, deletedMessage, true)
    await addEvent(wsA, foreignDeleted, author, deletedMessage)

    const foreignArrival = await seedChannel(wsA)
    await addEvent(wsA, foreignArrival, user)
    await addEvent(wsB, foreignArrival, bAuthor)

    const arrivals = await ReadStateRepository.listInboxArrivals(pool, wsA, user, [
      foreignReadState,
      foreignFloor,
      foreignDeleted,
      foreignArrival,
    ])

    expect(Object.keys(arrivals).sort()).toEqual([foreignReadState, foreignFloor, foreignDeleted].sort())
  })

  test("should repoint to its own workspace's previous event when another workspace's event sits just below the moved one", async () => {
    const stream = await seedChannel(wsA)
    const user = userId()
    const previous = await addEvent(wsA, stream, author)
    await addEvent(wsB, stream, bAuthor)
    const moved = await addEvent(wsA, stream, author)
    await addReadState(wsA, stream, user, { lastReadEventId: moved.id, held: true, floorEventId: moved.id })

    await ReadStateRepository.repointForMovedEvents(pool, wsA, stream, [
      { eventId: moved.id, sequence: moved.sequence },
    ])

    expect(await ReadStateRepository.get(pool, wsA, stream, user)).toEqual(
      expect.objectContaining({ lastReadEventId: previous.id, inboxFloorEventId: previous.id })
    )
  })

  test("should count only readers whose watermark is their own workspace's event when resolving users read through a sequence", async () => {
    const { stream, a1, b1 } = await seedCrossStream()
    const pointsAtForeign = userId()
    const readsOwn = userId()
    await addReadState(wsA, stream, pointsAtForeign, { lastReadEventId: b1.id })
    await addReadState(wsA, stream, readsOwn, { lastReadEventId: a1.id })

    expect(await usersReadThroughEffective(pool, wsA, stream, [pointsAtForeign, readsOwn], a1.sequence)).toEqual(
      new Set([readsOwn])
    )
  })

  describe("notification inheritance", () => {
    async function resolveThreadMember(parentStreamId: string, memberId: string) {
      const thread = (await StreamRepository.findById(pool, wsA, threadA))!
      return resolveNotificationLevelsForStream(pool, { ...thread, parentStreamId }, [
        { streamId: thread.id, memberId, notificationLevel: null, joinedAt: new Date() },
      ])
    }

    async function setLevel(wid: string, stream: string, member: string, level: "everything" | "muted") {
      await StreamMemberRepository.insert(pool, wid, stream, member)
      await StreamMemberRepository.update(pool, wid, stream, member, { notificationLevel: level })
    }

    test("should not inherit when the parent stream belongs to another workspace", async () => {
      const member = userId()
      await setLevel(wsA, channelB, member, "everything")

      expect(await resolveThreadMember(channelB, member)).toEqual([
        { memberId: member, effectiveLevel: "activity", source: "default" },
      ])
    })

    test("should not inherit when the grandparent stream belongs to another workspace", async () => {
      const parent = await seedChannel(wsA)
      await pool.query(`UPDATE streams SET parent_stream_id = $1 WHERE workspace_id = $2 AND id = $3`, [
        channelB,
        wsA,
        parent,
      ])
      const member = userId()
      await setLevel(wsA, channelB, member, "muted")

      expect(await resolveThreadMember(parent, member)).toEqual([
        { memberId: member, effectiveLevel: "activity", source: "default" },
      ])
    })

    test("should not inherit when the parent membership belongs to another workspace", async () => {
      const parent = await seedChannel(wsA)
      const member = userId()
      await setLevel(wsB, parent, member, "everything")

      expect(await resolveThreadMember(parent, member)).toEqual([
        { memberId: member, effectiveLevel: "activity", source: "default" },
      ])
    })
  })

  test("should find the compaction target within its own workspace's overlay when another workspace's overlay is higher", async () => {
    const stream = await seedChannel(wsA)
    const member = userId()
    const read = await addEvent(wsA, stream, author)
    const deleted = await addEvent(wsA, stream, author)
    await addMessage(wsA, stream, deleted.messageId, true)
    const foreign = await addEvent(wsB, stream, bAuthor)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: stream,
      memberId: member,
      messageIds: [read.messageId],
    })
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsB,
      streamId: stream,
      memberId: member,
      messageIds: [foreign.messageId],
    })

    expect(await SparseReadRepository.findCompactionTarget(pool, wsA, stream, member, 0n)).toEqual({
      eventId: read.id,
      sequence: read.sequence,
    })
  })

  test("should leave a message uncovered when only another workspace's overlay row covers it", async () => {
    const stream = await seedChannel(wsA)
    const member = userId()
    const uncovered = await addEvent(wsA, stream, author)
    const read = await addEvent(wsA, stream, author)
    await addOverlay(wsB, stream, member, uncovered)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: stream,
      memberId: member,
      messageIds: [read.messageId],
    })

    expect(await SparseReadRepository.findCompactionTarget(pool, wsA, stream, member, 0n)).toBeNull()
  })

  test("should leave a message uncovered when only another workspace's deleted message matches its id", async () => {
    const stream = await seedChannel(wsA)
    const member = userId()
    const foreignDeleted = messageId()
    await addMessage(wsB, channelB, foreignDeleted, true)
    await addEvent(wsA, stream, author, foreignDeleted)
    const read = await addEvent(wsA, stream, author)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: stream,
      memberId: member,
      messageIds: [read.messageId],
    })

    expect(await SparseReadRepository.findCompactionTarget(pool, wsA, stream, member, 0n)).toBeNull()
  })

  test("should not extend the compaction run through another workspace's event when an overlay row points at it", async () => {
    const stream = await seedChannel(wsA)
    const member = userId()
    const read = await addEvent(wsA, stream, author)
    const foreign = await addEvent(wsB, stream, bAuthor)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: stream,
      memberId: member,
      messageIds: [read.messageId],
    })
    await addOverlay(wsA, stream, member, foreign)

    expect(await SparseReadRepository.findCompactionTarget(pool, wsA, stream, member, 0n)).toEqual({
      eventId: read.id,
      sequence: read.sequence,
    })
  })

  test("should end the trailing deleted run before a message that only another workspace's deleted message matches", async () => {
    const stream = await seedChannel(wsA)
    const deleted = await addEvent(wsA, stream, author)
    await addMessage(wsA, stream, deleted.messageId, true)
    const foreignDeleted = messageId()
    await addMessage(wsB, channelB, foreignDeleted, true)
    await addEvent(wsA, stream, author, foreignDeleted)

    expect(await SparseReadRepository.findTrailingDeletedRunEnd(pool, wsA, stream, 0n)).toEqual({
      eventId: deleted.id,
      sequence: deleted.sequence,
    })
  })

  test("should ignore another workspace's live event when ending the trailing deleted run", async () => {
    const stream = await seedChannel(wsA)
    const first = await addEvent(wsA, stream, author)
    await addMessage(wsA, stream, first.messageId, true)
    await addEvent(wsB, stream, bAuthor)
    const last = await addEvent(wsA, stream, author)
    await addMessage(wsA, stream, last.messageId, true)

    expect(await SparseReadRepository.findTrailingDeletedRunEnd(pool, wsA, stream, 0n)).toEqual({
      eventId: last.id,
      sequence: last.sequence,
    })
  })

  test("should rehome only its own workspace's overlay rows onto its own workspace's destination events", async () => {
    const source = await seedChannel(wsA)
    const destination = await seedChannel(wsA)
    const member = userId()
    const foreignMember = userId()

    const moved = await addEvent(wsA, source, author)
    const movedDestination = await addEvent(wsA, destination, author, moved.messageId)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: source,
      memberId: member,
      messageIds: [moved.messageId],
    })
    await addOverlay(wsB, source, foreignMember, moved)

    const unmatched = await addEvent(wsA, source, author)
    await addEvent(wsB, destination, bAuthor, unmatched.messageId)
    await SparseReadRepository.insertReads(pool, {
      workspaceId: wsA,
      streamId: source,
      memberId: member,
      messageIds: [unmatched.messageId],
    })

    await SparseReadRepository.rehomeReads(pool, {
      workspaceId: wsA,
      sourceStreamId: source,
      destinationStreamId: destination,
      messageIds: [moved.messageId, unmatched.messageId],
    })

    expect({
      moved: await overlayRow(member, moved.messageId),
      foreign: await overlayRow(foreignMember, moved.messageId),
      unmatched: await overlayRow(member, unmatched.messageId),
    }).toEqual({
      moved: { workspace_id: wsA, stream_id: destination, event_id: movedDestination.id },
      foreign: { workspace_id: wsB, stream_id: source, event_id: moved.id },
      unmatched: { workspace_id: wsA, stream_id: source, event_id: unmatched.id },
    })
  })
})
