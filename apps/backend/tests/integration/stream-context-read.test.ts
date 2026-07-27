/**
 * "In this stream" read path, against a real schema.
 *
 * Every read goes through one `scopedSql` fragment that names columns on six
 * tables and aliases them into the row mapper. Nothing about that survives a
 * fake Querier: `th.name` (renamed to `display_name` in 2025) sat in the SELECT
 * list through 53 green unit tests, and an assertion on the query's TEXT cannot
 * tell a column that exists from one that does not. These run the SQL and read
 * the mapped result.
 *
 * The behavioural case that matters most is INV-62: a thread the viewer is not
 * a member of, under a channel they can read, must appear in the tree-scoped
 * feed — membership is not access, and filtering on `stream_members` silently
 * drops thread content.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { MemoRepository } from "../../src/features/memos"
import { LinkPreviewRepository, normalizeUrl } from "../../src/features/link-previews"
import { createStreamContextService } from "../../src/features/stream-context"
import { StreamContextRepository } from "../../src/features/stream-context/repository"
import { linkPreviewId, memoId, streamContextItemId, userId, workspaceId } from "../../src/lib/id"
import { sql } from "../../src/db"
import { StreamTypes, Visibilities } from "@threa/types"

let pool: Pool

beforeAll(async () => {
  pool = await setupTestDatabase()
})

afterAll(async () => {
  await pool.end()
})

describe("stream context read path", () => {
  let streamService: StreamService
  let eventService: EventService
  let service: ReturnType<typeof createStreamContextService>

  const wsId = workspaceId()
  const memberId = userId()
  const outsiderId = userId()
  let channelId: string
  let threadId: string

  beforeAll(async () => {
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

  test("a delegation row carries its created event as the jump target", async () => {
    // Delegations live in an event, not a message, so the feed's only deep-link
    // target is the `delegation:created` card. The join that resolves it is the
    // thing that can silently break.
    const taskId = `dtask_${wsId.slice(-10)}`
    const eventRow = await withTransaction(pool, async (client) => {
      await client.query(sql`
        INSERT INTO delegated_tasks (id, workspace_id, stream_id, created_by_kind, created_by_id, title, brief)
        VALUES (${taskId}, ${wsId}, ${channelId}, 'user', ${memberId}, 'Ship the thing', 'brief')
      `)
      const event = await client.query<{ id: string }>(sql`
        INSERT INTO stream_events (id, stream_id, sequence, event_type, payload, actor_id, actor_type)
        VALUES (
          ${`event_${taskId}`}, ${channelId}, 9999, 'delegation:created',
          ${JSON.stringify({ delegationId: taskId })}::jsonb, ${memberId}, 'user'
        )
        RETURNING id
      `)
      await client.query(sql`
        INSERT INTO stream_context_items
          (id, workspace_id, stream_id, root_stream_id, category, ref_kind, ref_id, group_key, occurred_at, snippet, detail)
        VALUES (
          ${`sctx_${taskId}`}, ${wsId}, ${channelId}, ${channelId}, 'delegation', 'delegation',
          ${taskId}, ${taskId}, NOW(), 'Ship the thing', '{}'::jsonb
        )
      `)
      return event.rows[0]!.id
    })

    const response = await service.list({
      workspaceId: wsId,
      userId: memberId,
      streamId: channelId,
      scope: "stream",
      category: "delegation",
      limit: 40,
    })

    expect(response.items.map((item) => ({ refId: item.refId, anchorEventId: item.anchorEventId }))).toEqual([
      { refId: taskId, anchorEventId: eventRow },
    ])
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

/**
 * Collapse, the live display joins, and the filters — the parts that used to be
 * pinned by asserting clause text. A repeated link, a preview row reached
 * through `normalized_url`, and a memo landmark are enough to tell a working
 * join from one that returns the right shape and the wrong data.
 */
describe("stream context feed: collapse, display joins, filters", () => {
  const wsId = workspaceId()
  const authorA = userId()
  const authorB = userId()
  const REPORT_URL = "https://example.com/report"
  const OTHER_URL = "https://example.com/other"
  const GIPHY_URL = "https://media.giphy.com/dancing.gif"

  let service: ReturnType<typeof createStreamContextService>
  let channelId: string
  let firstMessageId: string
  const memoRefId = memoId()

  beforeAll(async () => {
    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)
    service = createStreamContextService({ pool })

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Feed WS",
        slug: `feed-ws-${wsId}`,
        createdBy: authorA,
      })
      await addTestMember(client, wsId, authorA)
      await addTestMember(client, wsId, authorB)
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "feed-channel",
      slug: `feed-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: authorA,
    })
    channelId = channel.id

    const first = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: authorA,
      authorType: "user",
      ...testMessageContent(`quarterly numbers ${REPORT_URL}`),
    })
    firstMessageId = first.id

    // Second occurrence of the SAME url by a different author: the feed must
    // collapse the two onto one row while counts and occurrences see both.
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: authorB,
      authorType: "user",
      ...testMessageContent(`again ${REPORT_URL}`),
    })

    // "budget" appears ONLY in this message's body. Free text must not reach it:
    // every artifact of a message carries the same snippet, so one message with
    // five links would match all five on a term naming one.
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: authorA,
      authorType: "user",
      ...testMessageContent(`budget notes ${OTHER_URL}`),
    })

    const preview = await withTransaction(pool, async (client) =>
      LinkPreviewRepository.insert(client, {
        id: linkPreviewId(),
        workspaceId: wsId,
        url: REPORT_URL,
        normalizedUrl: normalizeUrl(REPORT_URL),
        contentType: "website",
      })
    )
    await withTransaction(pool, async (client) =>
      LinkPreviewRepository.updateMetadata(client, wsId, preview.id, {
        title: "Quarterly budget",
        description: "The numbers",
        siteName: "example.com",
        contentType: "website",
        status: "completed",
      })
    )

    await withTransaction(pool, async (client) => {
      await MemoRepository.insert(client, {
        id: memoRefId,
        workspaceId: wsId,
        memoType: "message",
        sourceMessageId: firstMessageId,
        title: "Budget memo",
        abstract: "What we settled on",
        sourceMessageIds: [firstMessageId],
        participantIds: [authorA],
        knowledgeType: "decision",
      })
    })

    // The memo landmark and the giphy embed are written by hooks the message
    // path doesn't run here; the statement is the production one either way.
    await StreamContextRepository.insertMany(pool, [
      {
        id: streamContextItemId(),
        workspaceId: wsId,
        streamId: channelId,
        rootStreamId: channelId,
        category: "memo",
        refKind: "memo",
        refId: memoRefId,
        groupKey: memoRefId,
        sourceMessageId: firstMessageId,
        authorId: authorA,
        occurredAt: new Date(),
        sequence: null,
        snippet: "Budget memo",
        detail: {},
      },
      {
        id: streamContextItemId(),
        workspaceId: wsId,
        streamId: channelId,
        rootStreamId: channelId,
        category: "media",
        refKind: "giphy",
        refId: GIPHY_URL,
        groupKey: GIPHY_URL,
        sourceMessageId: firstMessageId,
        authorId: authorA,
        occurredAt: new Date(),
        sequence: null,
        snippet: "look",
        detail: { giphyUrl: GIPHY_URL, title: "dancing", width: 200, height: 100 },
      },
    ])
  })

  test("a url shared twice collapses to one row carrying its occurrence count", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      limit: 40,
    })

    expect(response.items.map((item) => ({ refId: item.refId, occurrenceCount: item.occurrenceCount }))).toEqual([
      { refId: OTHER_URL, occurrenceCount: 1 },
      { refId: REPORT_URL, occurrenceCount: 2 },
    ])
  })

  test("link display data is joined live from link_previews on normalized_url", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      limit: 40,
    })

    const report = response.items.find((item) => item.refId === REPORT_URL)!
    const other = response.items.find((item) => item.refId === OTHER_URL)!
    expect({ report: report.detail, otherTitle: (other.detail as { title: string | null }).title }).toEqual({
      report: {
        url: REPORT_URL,
        title: "Quarterly budget",
        description: "The numbers",
        siteName: "example.com",
        faviconUrl: null,
        imageUrl: null,
        previewType: null,
        contentType: "website",
        previewStatus: "completed",
      },
      // No preview row for this url: the join contributes nothing rather than
      // dropping the item.
      otherTitle: null,
    })
  })

  test("free text reaches the joined preview and memo titles but never the message snippet", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      queryText: "budget",
      limit: 40,
    })

    expect(response.items.map((item) => item.refId).sort()).toEqual([REPORT_URL, memoRefId].sort())
  })

  test("free text matches the indexed ref itself", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      queryText: "/other",
      limit: 40,
    })

    expect(response.items.map((item) => item.refId)).toEqual([OTHER_URL])
  })

  test("the author filter narrows the set the collapse runs over, not just the visible row", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      authorId: authorB,
      limit: 40,
    })

    expect(response.items.map((item) => ({ refId: item.refId, occurrenceCount: item.occurrenceCount }))).toEqual([
      { refId: REPORT_URL, occurrenceCount: 1 },
    ])
  })

  test("the date bounds cut on the stored occurred_at", async () => {
    const all = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      limit: 40,
    })
    // Read the boundary back out of the rows the write path stamped, rather
    // than fabricating one: pg keeps microseconds a JS Date cannot hold, so a
    // hand-built timestamp compares against a value that never occurs (INV-66).
    const newest = new Date(all.items[0]!.occurredAt)

    const after = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      after: newest,
      limit: 40,
    })
    const before = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      before: newest,
      limit: 40,
    })

    expect({
      afterIsInclusive: after.items.map((item) => item.refId),
      beforeIsExclusive: before.items.map((item) => item.refId),
    }).toEqual({
      afterIsInclusive: [OTHER_URL],
      beforeIsExclusive: [REPORT_URL],
    })
  })

  test("counts are distinct artifacts over the whole scope, unnarrowed by the category chip", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "memo",
      limit: 40,
    })

    expect({ items: response.items.map((item) => item.refId), counts: response.counts }).toEqual({
      items: [memoRefId],
      counts: { link: 2, media: 1, file: 0, memo: 1, delegation: 0, thread: 0 },
    })
  })

  test("listOccurrences returns the uncollapsed rows behind one collapsed item", async () => {
    const response = await service.listOccurrences({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "link",
      groupKey: normalizeUrl(REPORT_URL),
      limit: 40,
    })

    expect({
      refIds: response.items.map((item) => item.refId),
      authors: response.items.map((item) => item.authorId).sort(),
      occurrenceCounts: response.items.map((item) => item.occurrenceCount),
    }).toEqual({
      refIds: [REPORT_URL, REPORT_URL],
      authors: [authorA, authorB].sort(),
      occurrenceCounts: [1, 1],
    })
  })

  test("a giphy embed maps its dimensions from the stored detail, with no attachment row to join", async () => {
    const response = await service.list({
      workspaceId: wsId,
      userId: authorA,
      streamId: channelId,
      scope: "tree",
      category: "media",
      limit: 40,
    })

    expect(response.items.map((item) => item.detail)).toEqual([
      {
        attachmentId: null,
        filename: null,
        mimeType: null,
        sizeBytes: null,
        width: 200,
        height: 100,
        mediaKind: "gif",
        giphyUrl: GIPHY_URL,
        giphyTitle: "dancing",
      },
    ])
  })
})
