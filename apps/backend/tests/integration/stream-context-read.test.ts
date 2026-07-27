/**
 * "In this stream" read path, against a real schema.
 *
 * The unit suites assert query SHAPE against a fake Querier, which cannot catch
 * a scope predicate that still names both columns or a join that quietly starts
 * filtering on membership. These run the generated SQL.
 *
 * The case that matters is INV-62: a thread the viewer is not a member of, under
 * a channel they can read, must appear in the tree-scoped feed — membership is
 * not access, and filtering on `stream_members` silently drops thread content.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { createStreamContextService } from "../../src/features/stream-context"
import { userId, workspaceId } from "../../src/lib/id"
import { StreamTypes, Visibilities } from "@threa/types"

describe("stream context read path", () => {
  let pool: Pool
  let streamService: StreamService
  let eventService: EventService
  let service: ReturnType<typeof createStreamContextService>

  const wsId = workspaceId()
  const memberId = userId()
  const outsiderId = userId()
  let channelId: string
  let threadId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    eventService = new EventService(pool)
    service = createStreamContextService({ pool })

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Context WS",
        slug: `context-ws-${wsId}`,
        createdBy: memberId,
      })
      await addTestMember(client, wsId, memberId)
      await addTestMember(client, wsId, outsiderId)
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "context-channel",
      slug: `context-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: memberId,
    })
    channelId = channel.id

    const anchor = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: memberId,
      authorType: "user",
      ...testMessageContent("channel link https://example.com/channel-doc"),
    })

    // The thread is created by the OUTSIDER, so the member holds no membership
    // row on it — the case a `stream_members` filter would drop.
    const thread = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.THREAD,
      parentStreamId: channelId,
      parentAnchorId: anchor.id,
      createdBy: outsiderId,
    })
    threadId = thread.id

    await eventService.createMessage({
      workspaceId: wsId,
      streamId: threadId,
      authorId: outsiderId,
      authorType: "user",
      ...testMessageContent("thread link https://example.com/thread-doc"),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("scope=tree returns a link shared in a thread the viewer never joined", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: channelId,
      scope: "tree",
      limit: 40,
    })

    expect({
      mode: response.mode,
      urls: response.items
        .filter((item) => item.category === "link")
        .map((item) => item.refId)
        .sort(),
      linkCount: response.counts?.link,
    }).toEqual({
      mode: "index",
      urls: ["https://example.com/channel-doc", "https://example.com/thread-doc"],
      linkCount: 2,
    })
  })

  test("scope=stream returns the channel's own rows and the thread it spawned", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: channelId,
      scope: "stream",
      limit: 40,
    })

    const rows = response.items
      .map((item) => ({ category: item.category, refId: item.refId }))
      .sort((a, b) => a.category.localeCompare(b.category))
    expect(rows).toEqual([
      { category: "link", refId: "https://example.com/channel-doc" },
      { category: "thread", refId: threadId },
    ])
  })

  test("the thread's own feed carries its link", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: threadId,
      scope: "stream",
      limit: 40,
    })

    expect(response.items.map((item) => item.refId)).toEqual(["https://example.com/thread-doc"])
  })

  test("a filtered feed pages by the filter's own cursor", async () => {
    const first = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: channelId,
      scope: "tree",
      category: "link",
      limit: 1,
    })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()

    const second = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: channelId,
      scope: "tree",
      category: "link",
      cursor: first.nextCursor!,
      limit: 1,
    })

    expect({
      secondRefIds: second.items.map((item) => item.refId),
      overlapsFirstPage: second.items.some((item) => item.key === first.items[0]!.key),
      countsOnlyOnFirstPage: second.counts,
    }).toEqual({
      secondRefIds: ["https://example.com/channel-doc"],
      overlapsFirstPage: false,
      countsOnlyOnFirstPage: null,
    })
  })
})
