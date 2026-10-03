import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, NotificationLevels, StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { composeSql } from "../../src/db"
import { EventService, MessageRepository } from "../../src/features/messaging"
import {
  DIRECTORY_ACTIVITY_DAYS,
  StreamDirectoryStatsRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
  checkStreamAccess,
  listAccessibleStreamIds,
  listRoomReadableStreamIds,
  streamAccessPredicateSql,
} from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("StreamMemberRepository workspace scope (INV-8)", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let suffix: string
  let counter: number

  async function seedWorkspace(label: string, memberCount: number) {
    const id = workspaceId()
    const userIds = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Member scope ${label}`,
        slug: `member-scope-${label}-${id}`,
        createdBy: userId(),
      })
      const members: string[] = []
      for (let index = 0; index < memberCount; index += 1) {
        members.push((await addTestMember(client, id, userId())).id)
      }
      return members
    })
    return { id, userIds }
  }

  async function seedPair() {
    const a = await seedWorkspace("a", 2)
    const b = await seedWorkspace("b", 1)
    return { wsA: a.id, wsB: b.id, userA1: a.userIds[0], userA2: a.userIds[1], userB: b.userIds[0] }
  }

  function createChannel(workspace: string, createdBy: string, visibility: Visibility) {
    counter += 1
    return streamService.createChannel({
      workspaceId: workspace,
      slug: `member-scope-${suffix}-${counter}`,
      createdBy,
      visibility,
    })
  }

  async function insertThread(workspace: string, createdBy: string, parentStreamId: string, rootStreamId: string) {
    counter += 1
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: workspace,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId,
      parentAnchorId: `msg_member_scope_${suffix}_${counter}`,
      rootStreamId,
      createdBy,
    })
    return id
  }

  const memberIds = (members: Array<{ memberId: string }>) => members.map((member) => member.memberId).sort()

  async function memberRows(streamIds: string[]) {
    const result = await pool.query<{ workspace_id: string; stream_id: string; member_id: string }>(
      `SELECT workspace_id, stream_id, member_id FROM stream_members WHERE stream_id = ANY($1)`,
      [streamIds]
    )
    return result.rows.map((row) => `${row.workspace_id}:${row.stream_id}:${row.member_id}`).sort()
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    suffix = Math.random().toString(36).slice(2, 8)
    counter = 0
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should find memberships only for their own workspace when reading by stream and member ids", async () => {
    const { wsA, wsB, userA1, userA2, userB } = await seedPair()
    const privateA = (await createChannel(wsA, userA1, Visibilities.PRIVATE)).id
    await StreamMemberRepository.insert(pool, wsA, privateA, userA2)
    const otherPrivateA = (await createChannel(wsA, userA1, Visibilities.PRIVATE)).id

    const lookups = async (workspace: string) => {
      const locked = await withTransaction(pool, async (client) => ({
        memberships: await StreamMemberRepository.lockMemberships(client, workspace, [privateA, otherPrivateA], userA1),
        pairs: await StreamMemberRepository.lockMemberPairs(client, workspace, [
          { streamId: privateA, memberId: userA1 },
          { streamId: privateA, memberId: userA2 },
        ]),
        count: await StreamMemberRepository.countByStreamForUpdate(client, workspace, privateA),
      }))
      const streamIds = (members: Array<{ streamId: string }>) => members.map((member) => member.streamId).sort()

      return {
        findByStreamAndMember:
          (await StreamMemberRepository.findByStreamAndMember(pool, workspace, privateA, userA2))?.memberId ?? null,
        findByStreamsAndMember: streamIds(
          await StreamMemberRepository.findByStreamsAndMember(pool, workspace, [privateA, otherPrivateA], userA1)
        ),
        listByMember: streamIds(await StreamMemberRepository.list(pool, workspace, { memberId: userA1 })),
        listByStream: memberIds(await StreamMemberRepository.list(pool, workspace, { streamId: privateA })),
        listByStreams: (await StreamMemberRepository.list(pool, workspace, { streamIds: [privateA, otherPrivateA] }))
          .map((member) => `${member.streamId}:${member.memberId}`)
          .sort(),
        listPaginated: memberIds(await StreamMemberRepository.listPaginated(pool, workspace, privateA)),
        listPaginatedAfterCursor: memberIds(
          await StreamMemberRepository.listPaginated(pool, workspace, privateA, {
            cursorJoinedAt: new Date(0),
            cursorMemberId: "usr_0",
          })
        ),
        isMember: await StreamMemberRepository.isMember(pool, workspace, privateA, userA1),
        filterMemberIds: [
          ...(await StreamMemberRepository.filterMemberIds(pool, workspace, privateA, [userA1, userA2, userB])),
        ].sort(),
        countMembersNotIn: await StreamMemberRepository.countMembersNotIn(pool, workspace, privateA, otherPrivateA),
        lockMemberships: [...locked.memberships].sort(),
        lockMemberPairs: [...locked.pairs].sort(),
        countByStreamForUpdate: locked.count,
      }
    }

    expect({ ownWorkspace: await lookups(wsA), otherWorkspace: await lookups(wsB) }).toEqual({
      ownWorkspace: {
        findByStreamAndMember: userA2,
        findByStreamsAndMember: [privateA, otherPrivateA].sort(),
        listByMember: [privateA, otherPrivateA].sort(),
        listByStream: [userA1, userA2].sort(),
        listByStreams: [`${privateA}:${userA1}`, `${privateA}:${userA2}`, `${otherPrivateA}:${userA1}`].sort(),
        listPaginated: [userA1, userA2].sort(),
        listPaginatedAfterCursor: [userA1, userA2].sort(),
        isMember: true,
        filterMemberIds: [userA1, userA2].sort(),
        countMembersNotIn: 1,
        lockMemberships: [privateA, otherPrivateA].sort(),
        lockMemberPairs: [`${privateA}:${userA1}`, `${privateA}:${userA2}`].sort(),
        countByStreamForUpdate: 2,
      },
      otherWorkspace: {
        findByStreamAndMember: null,
        findByStreamsAndMember: [],
        listByMember: [],
        listByStream: [],
        listByStreams: [],
        listPaginated: [],
        listPaginatedAfterCursor: [],
        isMember: false,
        filterMemberIds: [],
        countMembersNotIn: 0,
        lockMemberships: [],
        lockMemberPairs: [],
        countByStreamForUpdate: 0,
      },
    })
  })

  test("should return only its own workspace's members when another workspace has members under the same stream id", async () => {
    const { wsA, wsB, userA1, userB } = await seedPair()
    const channel = await createChannel(wsA, userA1, Visibilities.PRIVATE)
    await StreamMemberRepository.insert(pool, wsB, channel.id, userB)
    const locked = await withTransaction(pool, async (client) => ({
      a: await StreamMemberRepository.countByStreamForUpdate(client, wsA, channel.id),
      b: await StreamMemberRepository.countByStreamForUpdate(client, wsB, channel.id),
    }))

    expect({
      listedForA: memberIds(await StreamMemberRepository.list(pool, wsA, { streamId: channel.id })),
      listedForB: memberIds(await StreamMemberRepository.list(pool, wsB, { streamId: channel.id })),
      pagedForA: memberIds(await StreamMemberRepository.listPaginated(pool, wsA, channel.id)),
      pagedForB: memberIds(await StreamMemberRepository.listPaginated(pool, wsB, channel.id)),
      filteredForA: [...(await StreamMemberRepository.filterMemberIds(pool, wsA, channel.id, [userA1, userB]))],
      filteredForB: [...(await StreamMemberRepository.filterMemberIds(pool, wsB, channel.id, [userA1, userB]))],
      lockedCounts: locked,
    }).toEqual({
      listedForA: [userA1],
      listedForB: [userB],
      pagedForA: [userA1],
      pagedForB: [userB],
      filteredForA: [userA1],
      filteredForB: [userB],
      lockedCounts: { a: 1, b: 1 },
    })
  })

  test("should count a member as missing from the other stream when the only matching row there belongs to another workspace", async () => {
    const { wsA, wsB, userA1, userA2 } = await seedPair()
    const target = await createChannel(wsA, userA1, Visibilities.PRIVATE)
    const other = await createChannel(wsA, userA2, Visibilities.PRIVATE)
    await StreamMemberRepository.insert(pool, wsB, other.id, userA1)

    expect({
      ownWorkspace: await StreamMemberRepository.countMembersNotIn(pool, wsA, target.id, other.id),
      otherWorkspace: await StreamMemberRepository.countMembersNotIn(pool, wsB, target.id, other.id),
    }).toEqual({ ownWorkspace: 1, otherWorkspace: 0 })
  })

  test("should leave the membership unchanged when update runs for another workspace", async () => {
    const { wsA, wsB, userA1 } = await seedPair()
    const channel = await createChannel(wsA, userA1, Visibilities.PRIVATE)
    const before = await StreamMemberRepository.findByStreamAndMember(pool, wsA, channel.id, userA1)

    const updated = await StreamMemberRepository.update(pool, wsB, channel.id, userA1, {
      notificationLevel: NotificationLevels.MUTED,
    })

    expect({
      updated,
      after: await StreamMemberRepository.findByStreamAndMember(pool, wsA, channel.id, userA1),
    }).toEqual({ updated: null, after: before })
  })

  test("should leave the membership in place when delete runs for another workspace", async () => {
    const { wsA, wsB, userA1 } = await seedPair()
    const channel = await createChannel(wsA, userA1, Visibilities.PRIVATE)
    const before = await StreamMemberRepository.list(pool, wsA, { streamId: channel.id })

    const deleted = await StreamMemberRepository.delete(pool, wsB, channel.id, userA1)

    expect({
      deleted,
      after: await StreamMemberRepository.list(pool, wsA, { streamId: channel.id }),
    }).toEqual({ deleted: false, after: before })
  })

  test("should only remove its own workspace's memberships when deleting a member from descendant threads", async () => {
    const { wsA, wsB, userA1, userA2, userB } = await seedPair()
    const root = (await createChannel(wsA, userA1, Visibilities.PRIVATE)).id
    const threadOfA = await insertThread(wsA, userA1, root, root)
    const threadOfB = await insertThread(wsB, userB, root, root)
    const otherThreadOfB = await insertThread(wsB, userB, root, root)
    const crossThreadOfA = await insertThread(wsA, userA1, threadOfB, root)
    await StreamMemberRepository.insert(pool, wsA, threadOfA, userA2)
    await StreamMemberRepository.insert(pool, wsB, threadOfA, userB)
    await StreamMemberRepository.insert(pool, wsB, threadOfB, userB)
    await StreamMemberRepository.insert(pool, wsA, otherThreadOfB, userB)
    await StreamMemberRepository.insert(pool, wsB, crossThreadOfA, userB)
    const threadIds = [threadOfA, threadOfB, otherThreadOfB, crossThreadOfA]

    const removedForB = await StreamMemberRepository.deleteByMemberInDescendants(pool, wsB, userB, root)
    const afterB = await memberRows(threadIds)
    const removedForA = await StreamMemberRepository.deleteByMemberInDescendants(pool, wsA, userA2, root)

    expect({ removedForB, afterB, removedForA, afterA: await memberRows(threadIds) }).toEqual({
      removedForB: [threadOfB],
      afterB: [
        `${wsB}:${crossThreadOfA}:${userB}`,
        `${wsA}:${otherThreadOfB}:${userB}`,
        `${wsA}:${threadOfA}:${userA2}`,
        `${wsB}:${threadOfA}:${userB}`,
      ].sort(),
      removedForA: [threadOfA],
      afterA: [
        `${wsB}:${crossThreadOfA}:${userB}`,
        `${wsA}:${otherThreadOfB}:${userB}`,
        `${wsB}:${threadOfA}:${userB}`,
      ].sort(),
    })
  })

  test("should not grant access from a membership row of another workspace when checking stream access", async () => {
    const { wsA, wsB, userA1, userA2 } = await seedPair()
    const channel = await createChannel(wsA, userA1, Visibilities.PRIVATE)
    await StreamMemberRepository.insert(pool, wsB, channel.id, userA2)
    const access = async (user: string) => ({
      checkStreamAccess: (await checkStreamAccess(pool, channel.id, wsA, user))?.id ?? null,
      listAccessibleStreamIds: [...(await listAccessibleStreamIds(pool, wsA, user, [channel.id]))],
    })

    expect({
      member: await access(userA1),
      holderOfAnotherWorkspacesRow: await access(userA2),
    }).toEqual({
      member: { checkStreamAccess: channel.id, listAccessibleStreamIds: [channel.id] },
      holderOfAnotherWorkspacesRow: { checkStreamAccess: null, listAccessibleStreamIds: [] },
    })
  })

  test("should not resolve an access root from another workspace when the thread's root id is a public stream there", async () => {
    const { wsA, wsB, userA1, userA2, userB } = await seedPair()
    const privateA = (await createChannel(wsA, userA1, Visibilities.PRIVATE)).id
    const publicB = (await createChannel(wsB, userB, Visibilities.PUBLIC)).id
    const crossThread = await insertThread(wsA, userA1, privateA, publicB)

    expect({
      accessible: [...(await listAccessibleStreamIds(pool, wsA, userA2, [crossThread, privateA, publicB]))],
      roomReadable: [...(await listRoomReadableStreamIds(pool, wsA, privateA, [crossThread, privateA, publicB]))],
    }).toEqual({ accessible: [], roomReadable: [privateA] })
  })

  test("should deny a stream of another workspace when the access predicate is the only workspace filter", async () => {
    const { wsA, wsB, userA1, userB } = await seedPair()
    const publicB = (await createChannel(wsB, userB, Visibilities.PUBLIC)).id
    const privateB = (await createChannel(wsB, userB, Visibilities.PRIVATE)).id
    await StreamMemberRepository.insert(pool, wsB, privateB, userA1)

    const result = await pool.query<{ id: string }>(composeSql`
      SELECT s.id FROM streams s
      WHERE s.id = ANY(${[publicB, privateB]}) AND ${streamAccessPredicateSql(wsA, userA1, "s.id")}
    `)

    expect(result.rows).toEqual([])
  })

  test("should count only its own workspace's members and messages when listing directory stats", async () => {
    const { wsA, wsB, userA1, userB } = await seedPair()
    const channel = await createChannel(wsA, userA1, Visibilities.PUBLIC)
    await eventService.createMessage({
      workspaceId: wsA,
      streamId: channel.id,
      authorId: userA1,
      authorType: AuthorTypes.USER,
      ...testMessageContent("Counted"),
    })
    await StreamMemberRepository.insert(pool, wsB, channel.id, userB)
    await MessageRepository.insert(pool, {
      id: messageId(),
      workspaceId: wsB,
      streamId: channel.id,
      sequence: 999n,
      authorId: userB,
      authorType: AuthorTypes.USER,
      ...testMessageContent("Not counted"),
    })
    const statsFor = async (workspace: string, viewer: string) =>
      (await StreamDirectoryStatsRepository.listForViewer(pool, workspace, viewer)).find(
        (stats) => stats.streamId === channel.id
      )

    expect({
      ownWorkspace: await statsFor(wsA, userA1),
      otherWorkspace: await statsFor(wsB, userB),
    }).toEqual({
      ownWorkspace: {
        streamId: channel.id,
        memberCount: 1,
        recentMemberIds: [userA1],
        activity: [1, ...new Array<number>(DIRECTORY_ACTIVITY_DAYS - 1).fill(0)],
      },
      otherWorkspace: undefined,
    })
  })
})
