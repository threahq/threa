/**
 * The activity feed and its unread counts follow the reader's current stream access (INV-62):
 * rows on a stream the reader can no longer read are hidden, never deleted, and come back when
 * access does. Exercised against the real schema (INV-68).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  ActivityTypes,
  AuthorTypes,
  StreamTypes,
  Visibilities,
  type JSONContent,
  type Visibility,
} from "@threahq/types"
import { ActivityRepository, ActivityService } from "../../src/features/activity"
import { EventService } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, streamId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase } from "./setup"

describe("activity feed access", () => {
  let pool: Pool
  let activityService: ActivityService
  let streamService: StreamService
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    activityService = new ActivityService({ pool })
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function workspaceWithUsers() {
    const ws = workspaceId()
    const owner = await addTestMember(pool, ws, `owner_${ws}`)
    const reader = await addTestMember(pool, ws, `reader_${ws}`)
    await WorkspaceRepository.insert(pool, { id: ws, name: "Feed WS", slug: `feed-${ws}`, createdBy: owner.id })
    return { ws, owner: owner.id, reader: reader.id }
  }

  function channel(ws: string, createdBy: string, visibility: Visibility) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      slug: `c-${streamId().slice(-8).toLowerCase()}`,
      visibility,
      createdBy,
    })
  }

  function thread(ws: string, root: { id: string }, createdBy: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.THREAD,
      displayName: "A thread",
      parentStreamId: root.id,
      rootStreamId: root.id,
      createdBy,
    })
  }

  async function mention(ws: string, userId: string, sid: string, actorId: string) {
    const row = await ActivityRepository.insert(pool, {
      workspaceId: ws,
      userId,
      activityType: ActivityTypes.MENTION,
      streamId: sid,
      messageId: messageId(),
      actorId,
      actorType: AuthorTypes.USER,
    })
    return row!.id
  }

  /** Everything the reader sees of their activity: feed, bootstrap counts, a stream's counts, push-payload counts. */
  async function view(ws: string, userId: string, sid: string) {
    const [feed, unread, grouped, forStream, pairs] = await Promise.all([
      activityService.listFeed(userId, ws),
      activityService.listFeed(userId, ws, { unreadOnly: true, othersOnly: true }),
      activityService.getUnreadCounts(userId, ws),
      activityService.getUnreadCountsForStream(userId, ws, sid),
      ActivityRepository.countUnreadForPairs(pool, ws, [{ userId, streamId: sid }]),
    ])
    return {
      feed: feed.map((a) => a.id),
      unread: unread.map((a) => a.id),
      total: grouped.total,
      totalByStream: Object.fromEntries(grouped.totalByStream),
      mentionsByStream: Object.fromEntries(grouped.mentionsByStream),
      forStream,
      forPair: pairs.get(`${userId}:${sid}`),
    }
  }

  function shown(sid: string, ids: string[]) {
    return {
      feed: [...ids].reverse(),
      unread: [...ids].reverse(),
      total: ids.length,
      totalByStream: { [sid]: ids.length },
      mentionsByStream: { [sid]: ids.length },
      forStream: { mentionCount: ids.length, totalCount: ids.length },
      forPair: { mentionCount: ids.length, totalCount: ids.length },
    }
  }

  const hidden = {
    feed: [],
    unread: [],
    total: 0,
    totalByStream: {},
    mentionsByStream: {},
    forStream: { mentionCount: 0, totalCount: 0 },
    forPair: { mentionCount: 0, totalCount: 0 },
  }

  test("should hide a private channel's rows once the reader is removed and bring them back when re-added", async () => {
    const { ws, owner, reader } = await workspaceWithUsers()
    const room = await channel(ws, owner, Visibilities.PRIVATE)
    await StreamMemberRepository.insertMany(pool, ws, room.id, [owner, reader])
    const first = await mention(ws, reader, room.id, owner)
    const second = await mention(ws, reader, room.id, owner)
    expect(await view(ws, reader, room.id)).toEqual(shown(room.id, [first, second]))

    await StreamMemberRepository.delete(pool, ws, room.id, reader)
    expect(await view(ws, reader, room.id)).toEqual(hidden)

    await activityService.markAllAsRead(reader, ws)
    await StreamMemberRepository.insertMany(pool, ws, room.id, [reader])
    expect(await view(ws, reader, room.id)).toEqual(shown(room.id, [first, second]))
  })

  test("should decide push-payload counts per user, not per stream", async () => {
    const { ws, owner, reader } = await workspaceWithUsers()
    const room = await channel(ws, owner, Visibilities.PRIVATE)
    await StreamMemberRepository.insertMany(pool, ws, room.id, [owner, reader])
    await mention(ws, reader, room.id, owner)
    await mention(ws, owner, room.id, reader)
    await StreamMemberRepository.delete(pool, ws, room.id, reader)

    const pairs = await ActivityRepository.countUnreadForPairs(pool, ws, [
      { userId: owner, streamId: room.id },
      { userId: reader, streamId: room.id },
    ])
    expect(Object.fromEntries(pairs)).toEqual({
      [`${owner}:${room.id}`]: { mentionCount: 1, totalCount: 1 },
      [`${reader}:${room.id}`]: { mentionCount: 0, totalCount: 0 },
    })
  })

  test("should show a thread's rows to a non-member of the thread inside a channel they belong to", async () => {
    const { ws, owner, reader } = await workspaceWithUsers()
    const room = await channel(ws, owner, Visibilities.PRIVATE)
    await StreamMemberRepository.insertMany(pool, ws, room.id, [owner, reader])
    const child = await thread(ws, room, owner)
    const row = await mention(ws, reader, child.id, owner)

    expect(await view(ws, reader, child.id)).toEqual(shown(child.id, [row]))
  })

  test("should show a public channel's rows to a non-member", async () => {
    const { ws, owner, reader } = await workspaceWithUsers()
    const room = await channel(ws, owner, Visibilities.PUBLIC)
    const row = await mention(ws, reader, room.id, owner)

    expect(await view(ws, reader, room.id)).toEqual(shown(room.id, [row]))
  })

  test("should show a doc's rows to a share grantee and hide them when the grant is revoked", async () => {
    const { ws, owner, reader } = await workspaceWithUsers()
    const host = await channel(ws, owner, Visibilities.PRIVATE)
    await StreamMemberRepository.insertMany(pool, ws, host.id, [owner])
    const doc = await streamService.create({
      workspaceId: ws,
      type: StreamTypes.DOC,
      parentStreamId: host.id,
      createdBy: owner,
    })
    const open = await channel(ws, owner, Visibilities.PUBLIC)
    const chip: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: doc.id, title: "Plan" } }] }],
    }
    const share = await eventService.createMessage({
      workspaceId: ws,
      streamId: open.id,
      authorId: owner,
      authorType: AuthorTypes.USER,
      contentJson: chip,
      contentMarkdown: "shared",
      confirmedPrivacyWarning: true,
    })
    const row = await mention(ws, reader, doc.id, owner)
    expect(await view(ws, reader, doc.id)).toEqual(shown(doc.id, [row]))

    await eventService.deleteMessageInternal({
      workspaceId: ws,
      messageId: share.id,
      streamId: open.id,
      actorId: owner,
    })
    expect(await view(ws, reader, doc.id)).toEqual(hidden)
  })
})
