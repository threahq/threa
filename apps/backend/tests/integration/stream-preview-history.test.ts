import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test"
import type { Pool } from "pg"
import {
  AUTHOR_SCOPED_EVENT_TYPES,
  STREAM_PREVIEW_HISTORY_MAX_STREAMS,
  type JSONContent,
  type StreamPreviewHistoryResult,
} from "@threahq/types"
import { setupIsolatedTestDatabase, testMessageContent } from "./setup"
import {
  streamId,
  userId,
  workspaceId,
  eventId,
  messageId,
  memoId,
  attachmentId,
  linkPreviewId,
} from "../../src/lib/id"
import { StreamRepository } from "../../src/features/streams"
import { StreamMemberRepository } from "../../src/features/streams/member-repository"
import { StreamEventRepository } from "../../src/features/streams/event-repository"
import { StreamPreviewHistoryService, previewHistorySchema } from "../../src/features/streams/preview-history-service"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { LinkPreviewService, LinkPreviewRepository } from "../../src/features/link-previews"
import { AttachmentRepository } from "../../src/features/attachments"
import { MemoRepository } from "../../src/features/memos"

describe("batched preview history", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let service: StreamPreviewHistoryService
  let previews: LinkPreviewService
  const workspace = workspaceId()
  const viewer = userId()
  const other = userId()
  const memberRoot = streamId()
  const publicRoot = streamId()
  const deniedRoot = streamId()
  const foreign = streamId()
  const missing = streamId()
  const thread = streamId()
  const deniedThread = streamId()
  const empty = streamId()
  const windowStream = streamId()
  let anchor: string

  async function seedMessage(stream: string, text: string, contentJson?: JSONContent) {
    const id = messageId()
    const content = { ...testMessageContent(text), ...(contentJson ? { contentJson } : {}) }
    const event = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: stream,
      eventType: "message_created",
      actorId: viewer,
      actorType: "user",
      payload: { messageId: id, authorId: viewer, authorType: "user", ...content },
    })
    await MessageRepository.insert(pool, {
      id,
      workspaceId: workspace,
      streamId: stream,
      sequence: event.sequence,
      authorId: viewer,
      authorType: "user",
      ...content,
    })
    return { id, event }
  }

  async function seedChannel(
    visibility: "public" | "private",
    { id = streamId(), inWorkspace = workspace }: { id?: string; inWorkspace?: string } = {}
  ) {
    await StreamRepository.insert(pool, {
      id,
      workspaceId: inWorkspace,
      type: "channel",
      visibility,
      slug: `preview-${id}`,
      createdBy: other,
    })
    return id
  }

  async function seedThread(
    root: string,
    parentAnchorId: string,
    { id = streamId(), createdBy = other }: { id?: string; createdBy?: string } = {}
  ) {
    await StreamRepository.insert(pool, {
      id,
      workspaceId: workspace,
      type: "thread",
      parentStreamId: root,
      rootStreamId: root,
      parentAnchorId,
      createdBy,
    })
    return id
  }

  async function seedMemo(sourceMessageId: string, title: string, abstract: string) {
    const id = memoId()
    await MemoRepository.insert(pool, {
      id,
      workspaceId: workspace,
      memoType: "message",
      sourceMessageId,
      sourceMessageIds: [sourceMessageId],
      participantIds: [viewer],
      title,
      abstract,
      keyPoints: [],
      knowledgeType: "decision",
      tags: [],
      status: "active",
    })
    return id
  }

  function okHistory(result: StreamPreviewHistoryResult) {
    if (result.status !== 200) throw new Error(`expected history for ${result.streamId}, got ${result.status}`)
    return result
  }

  test("should retain only reachable recursive slots including descendant placeholders", async () => {
    const [a, b, c] = await Promise.all([seedChannel("public"), seedChannel("public"), seedChannel("public")])
    const leaf = await seedMessage(c, "uncached leaf")
    const deleted = await seedMessage(c, "deleted leaf")
    await pool.query("UPDATE messages SET deleted_at = NOW() WHERE id = $1", [deleted.id])
    const privateLeaf = await seedMessage(deniedRoot, "private leaf")
    const absent = messageId()
    const refs = (...ids: string[]): JSONContent => ({
      type: "doc",
      content: ids.map((id) => ({ type: "sharedMessage", attrs: { messageId: id } })),
    })
    const middle = await seedMessage(b, "middle", refs(leaf.id, deleted.id, privateLeaf.id, absent))
    await seedMessage(a, "outer", refs(middle.id))
    const sibling = await seedMessage(c, "sibling only")
    await seedMessage(b, "sibling pointer", refs(sibling.id))
    const [outer, middleHistory] = (await service.get(workspace, viewer, [a, b])).results.map(okHistory)
    expect(
      Object.fromEntries(Object.entries(outer.history.sharedMessages!).map(([id, slot]) => [id, slot.state]))
    ).toEqual({
      [middle.id]: "ok",
      [leaf.id]: "ok",
      [deleted.id]: "deleted",
      [privateLeaf.id]: "private",
      [absent]: "missing",
    })
    expect(outer.history.slots).toMatchObject({
      [`shared:${leaf.id}`]: { state: "ok", contentMarkdown: "uncached leaf", createdAt: expect.any(String) },
      [`shared:${deleted.id}`]: { state: "deleted", deletedAt: expect.any(String) },
    })
    expect(middleHistory.history.sharedMessages).toHaveProperty(sibling.id)
  })

  test("should pin memo authorization to creation scope during a same-root projection move", async () => {
    const moveRoot = await seedChannel("public")
    const moveAnchor = (await seedMessage(moveRoot, "memo source")).id
    const moveSource = await seedThread(moveRoot, moveAnchor, { createdBy: viewer })
    const memo = await seedMemo(moveAnchor, "Pinned root", "root")
    const destinationAnchor = (await seedMessage(moveRoot, "move destination anchor")).id
    const destination = await seedThread(moveRoot, destinationAnchor, { createdBy: viewer })
    const body: JSONContent = { type: "doc", content: [{ type: "memoEmbed", attrs: { memoId: memo } }] }
    const citing = await seedMessage(moveSource, "moving citation", body)
    const events = new EventService(pool)
    const original = events.getMessagesByIds.bind(events)
    const spy = spyOn(events, "getMessagesByIds").mockImplementation(async (workspaceId, ids) => {
      await pool.query("UPDATE messages SET stream_id = $2 WHERE id = $1", [citing.id, destination])
      return original(workspaceId, ids)
    })
    try {
      const movingService = new StreamPreviewHistoryService({
        pool,
        eventService: events,
        linkPreviewService: previews,
      })
      const [result] = (await movingService.get(workspace, viewer, [moveSource])).results.map(okHistory)
      expect(result.history.events.find((event) => event.id === citing.event.id)?.payload).toMatchObject({
        memoEmbeds: [{ memoId: memo, title: "Pinned root" }],
      })
      const enriched = await events.enrichBootstrapEvents([citing.event], new Map(), new Map(), {
        workspaceId: workspace,
        streamId: moveSource,
      })
      expect(enriched[0].payload).toMatchObject({ memoEmbeds: [{ memoId: memo, title: "Pinned root" }] })
    } finally {
      spy.mockRestore()
    }
  })

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("preview_history")
    pool = isolated.pool
    cleanup = isolated.cleanup
    previews = new LinkPreviewService({ pool })
    service = new StreamPreviewHistoryService({
      pool,
      eventService: new EventService(pool),
      linkPreviewService: previews,
    })
    await seedChannel("private", { id: memberRoot })
    await seedChannel("public", { id: publicRoot })
    await seedChannel("private", { id: deniedRoot })
    await seedChannel("private", { id: foreign, inWorkspace: workspaceId() })
    await seedChannel("public", { id: empty })
    await seedChannel("public", { id: windowStream })
    await StreamMemberRepository.insert(pool, workspace, memberRoot, viewer)
    anchor = (await seedMessage(memberRoot, "anchor")).id
    await seedThread(memberRoot, anchor, { id: thread })
    await seedThread(deniedRoot, messageId(), { id: deniedThread })
    await seedMessage(thread, "latest reply")
    await StreamRepository.bumpThreadReplyCount(pool, workspace, thread, 1)
    await seedMessage(publicRoot, "public preview")
    await seedMessage(deniedRoot, "private secret")
    await seedMessage(deniedThread, "private thread secret")
    await seedMessage(foreign, "foreign secret")
  })

  afterAll(async () => {
    if (cleanup) await cleanup()
  })

  test("should return inherited and public histories while distinguishing denied and missing streams", async () => {
    const response = await service.get(workspace, viewer, [
      thread,
      publicRoot,
      memberRoot,
      deniedRoot,
      deniedThread,
      foreign,
      missing,
      empty,
    ])
    expect(
      response.results.map((result) =>
        result.status === 200
          ? {
              streamId: result.streamId,
              status: result.status,
              texts: result.history.events.map(
                (event) => (event.payload as { contentMarkdown?: string }).contentMarkdown
              ),
            }
          : result
      )
    ).toEqual([
      { streamId: thread, status: 200, texts: ["latest reply"] },
      { streamId: publicRoot, status: 200, texts: ["public preview"] },
      { streamId: memberRoot, status: 200, texts: ["anchor"] },
      { streamId: deniedRoot, status: 403, code: "FORBIDDEN" },
      { streamId: deniedThread, status: 403, code: "FORBIDDEN" },
      { streamId: foreign, status: 404, code: "NOT_FOUND" },
      { streamId: missing, status: 404, code: "NOT_FOUND" },
      { streamId: empty, status: 200, texts: [] },
    ])
    const result = okHistory(response.results[2])
    expect(result.history.events[0].payload).toMatchObject({
      messageId: anchor,
      threadId: thread,
      replyCount: 1,
      threadSummary: { latestReply: { contentMarkdown: "latest reply" } },
    })
    const emptyResult = okHistory(response.results[7])
    expect(emptyResult.history).toMatchObject({
      latestSequence: "0",
      hasOlderEvents: false,
      syncMode: "replace",
      slots: {},
      sharedMessages: {},
    })
  })

  test("should probe latest fifty visible rows in chronological order and retain an unfiltered head", async () => {
    const visible = await StreamEventRepository.insertMany(
      pool,
      Array.from({ length: 51 }, () => ({
        id: eventId(),
        workspaceId: workspace,
        streamId: windowStream,
        eventType: "member_joined" as const,
        payload: {},
        actorId: viewer,
      }))
    )
    const mine = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: windowStream,
      eventType: AUTHOR_SCOPED_EVENT_TYPES[0],
      payload: {},
      actorId: viewer,
    })
    const hidden = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: windowStream,
      eventType: AUTHOR_SCOPED_EVENT_TYPES[0],
      payload: {},
      actorId: other,
    })
    const windows = await StreamEventRepository.listPreviewWindows(pool, workspace, [windowStream, empty], viewer)
    const window = windows.get(windowStream)!
    expect({
      ids: window.events.map((event) => event.id),
      older: window.hasOlderEvents,
      head: window.latestSequence,
    }).toEqual({
      ids: [...visible.slice(2).map((event) => event.id), mine.id],
      older: true,
      head: hidden.sequence,
    })
    expect(windows.get(empty)).toEqual({ events: [], hasOlderEvents: false, latestSequence: null })
    const exact = await StreamEventRepository.insertMany(
      pool,
      Array.from({ length: 50 }, () => ({
        id: eventId(),
        workspaceId: workspace,
        streamId: empty,
        eventType: "member_joined" as const,
        payload: {},
      }))
    )
    const exactWindow = (await StreamEventRepository.listPreviewWindows(pool, workspace, [empty], viewer)).get(empty)!
    expect({ ids: exactWindow.events.map((event) => event.id), older: exactWindow.hasOlderEvents }).toEqual({
      ids: exact.map((event) => event.id),
      older: false,
    })
  })

  test("should recover edited and deleted projections behind the head and preserve sealed payloads", async () => {
    const edited = await seedMessage(publicRoot, "old")
    const deleted = await seedMessage(publicRoot, "deleted")
    const sealed = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: publicRoot,
      eventType: "message_created",
      actorId: viewer,
      payload: { messageId: messageId(), ciphertext: "opaque", envelope: { v: 1 }, e2eVersion: 1 },
    })
    await pool.query(
      "UPDATE messages SET content_json = $2, content_markdown = 'new', edited_at = NOW() WHERE id = $1",
      [edited.id, JSON.stringify(testMessageContent("new").contentJson)]
    )
    await pool.query("UPDATE messages SET deleted_at = NOW() WHERE id = $1", [deleted.id])
    await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: publicRoot,
      eventType: "message_edited",
      payload: { messageId: edited.id },
    })
    await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: publicRoot,
      eventType: "message_deleted",
      payload: { messageId: deleted.id },
    })
    const [result] = (await service.get(workspace, viewer, [publicRoot])).results.map(okHistory)
    const payloads = new Map(result.history.events.map((event) => [event.id, event.payload]))
    expect({
      edited: payloads.get(edited.event.id),
      deleted: payloads.get(deleted.event.id),
      sealed: payloads.get(sealed.id),
    }).toMatchObject({
      edited: { contentMarkdown: "new", editedAt: expect.any(String) },
      deleted: { deletedAt: expect.any(String) },
      sealed: { ciphertext: "opaque", envelope: { v: 1 }, e2eVersion: 1 },
    })
    expect(result.history.events.map((event) => event.eventType)).toEqual([
      "message_created",
      "message_created",
      "message_created",
      "message_created",
    ])
  })

  test("should keep memo summaries isolated by citing room root even when the viewer can read both rooms", async () => {
    const memo = await seedMemo(anchor, "Private room decision", "private")
    const body: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "memoEmbed", attrs: { memoId: memo, title: "stale" } }] }],
    }
    const ownCitation = await seedMessage(thread, "citation", body)
    const otherCitation = await seedMessage(publicRoot, "citation", body)
    await pool.query("UPDATE stream_events SET payload = payload || $2::jsonb WHERE id = $1", [
      otherCitation.event.id,
      JSON.stringify({ memoEmbeds: [{ memoId: memo, title: "stale secret" }] }),
    ])
    const batchSpy = spyOn(MemoRepository, "findEmbedSummariesByRoot")
    let results
    try {
      results = (await service.get(workspace, viewer, [thread, publicRoot])).results
      expect(batchSpy).toHaveBeenCalledTimes(1)
      expect(batchSpy.mock.calls[0]).toEqual([
        pool,
        workspace,
        expect.arrayContaining([
          { memoId: memo, citingRootStreamId: memberRoot },
          { memoId: memo, citingRootStreamId: publicRoot },
        ]),
      ])
    } finally {
      batchSpy.mockRestore()
    }
    const summaries = results.map(okHistory).map((result, index) => {
      const id = index === 0 ? ownCitation.event.id : otherCitation.event.id
      return (result.history.events.find((event) => event.id === id)!.payload as { memoEmbeds: unknown }).memoEmbeds
    })
    expect(summaries).toEqual([
      [
        {
          memoId: memo,
          title: "Private room decision",
          knowledgeType: "decision",
          memoType: "message",
          tags: [],
          updatedAt: expect.any(String),
          version: expect.any(Number),
        },
      ],
      [],
    ])
  })

  test("should hydrate shared slots and refresh reactions attachments and viewer link previews", async () => {
    const source = await seedMessage(memberRoot, "shared source")
    const sharedBody: JSONContent = {
      type: "doc",
      content: [{ type: "sharedMessage", attrs: { messageId: source.id, streamId: memberRoot } }],
    }
    const citing = await seedMessage(publicRoot, "shared pointer", sharedBody)
    await MessageRepository.addReaction(pool, workspace, citing.id, "👍", viewer)
    const attachment = attachmentId()
    await AttachmentRepository.insert(pool, {
      id: attachment,
      workspaceId: workspace,
      streamId: publicRoot,
      uploadedBy: viewer,
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 10,
      storagePath: "preview/video",
      processingStatus: "completed",
      safetyStatus: "clean",
    })
    await pool.query("UPDATE stream_events SET payload = payload || $2::jsonb WHERE id = $1", [
      citing.event.id,
      JSON.stringify({ attachments: [{ id: attachment, processingStatus: "pending" }] }),
    ])
    const visible = linkPreviewId()
    const dismissed = linkPreviewId()
    for (const id of [visible, dismissed]) {
      await LinkPreviewRepository.insert(pool, {
        id,
        workspaceId: workspace,
        url: `https://example.com/${id}`,
        normalizedUrl: `https://example.com/${id}`,
        contentType: "website",
      })
      await LinkPreviewRepository.overwriteMetadata(pool, workspace, id, {
        title: "fresh preview",
        status: "completed",
      })
      await LinkPreviewRepository.linkToMessage(pool, workspace, citing.id, id, 0)
    }
    await previews.dismiss(workspace, viewer, citing.id, dismissed)
    const [result, rootResult] = (await service.get(workspace, viewer, [publicRoot, memberRoot])).results.map(okHistory)
    const payload = result.history.events.find((event) => event.id === citing.event.id)!.payload
    expect(payload).toMatchObject({
      reactions: { "👍": [viewer] },
      attachments: [{ id: attachment, processingStatus: "completed" }],
      linkPreviews: [{ id: visible, title: "fresh preview" }],
    })
    const sharedSlot = expect.objectContaining({
      state: "ok",
      contentMarkdown: "shared source",
      createdAt: expect.any(String),
      editedAt: null,
    })
    expect(result.history).toMatchObject({
      sharedMessages: { [source.id]: sharedSlot },
      slots: { [`shared:${source.id}`]: sharedSlot },
    })
    expect(rootResult.history).toMatchObject({ slots: {}, sharedMessages: {} })
  })

  test("should refresh a message when a patch-only tail fills the history window", async () => {
    const patchStream = await seedChannel("public")
    const message = await seedMessage(patchStream, "before patch flood")
    const content = testMessageContent("after patch flood")
    await pool.query("UPDATE messages SET content_json = $2, content_markdown = $3, edited_at = NOW() WHERE id = $1", [
      message.id,
      content.contentJson,
      content.contentMarkdown,
    ])
    for (let index = 0; index < 51; index++) {
      await StreamEventRepository.insert(pool, {
        id: eventId(),
        workspaceId: workspace,
        streamId: patchStream,
        eventType: "message_edited",
        actorId: viewer,
        actorType: "user",
        payload: { messageId: message.id, ...content },
      })
    }
    const result = okHistory((await service.get(workspace, viewer, [patchStream])).results[0])
    expect(result.history.events.find((event) => event.id === message.event.id)?.payload).toMatchObject({
      contentMarkdown: "after patch flood",
      editedAt: expect.any(String),
    })
  })

  test("should retain creation anchors and projection state behind reaction and deletion tails", async () => {
    const stream = await seedChannel("public")
    const reacting = await seedMessage(stream, "reacted message")
    const deleted = await seedMessage(stream, "deleted message")
    await MessageRepository.addReaction(pool, workspace, reacting.id, "👍", viewer)
    await pool.query("UPDATE messages SET deleted_at = NOW() WHERE id = $1", [deleted.id])
    const patches = await StreamEventRepository.insertMany(
      pool,
      Array.from({ length: 51 }, (_, index) => ({
        id: eventId(),
        workspaceId: workspace,
        streamId: stream,
        eventType: (["reaction_added", "reaction_removed", "message_deleted"] as const)[index % 3],
        payload: { messageId: index % 3 === 2 ? deleted.id : reacting.id },
        actorId: viewer,
      }))
    )
    const [result] = (await service.get(workspace, viewer, [stream])).results.map(okHistory)
    expect({
      events: result.history.events.map((event) => ({
        id: event.id,
        type: event.eventType,
        sequence: event.sequence,
        broadcast: event.broadcastSequence,
      })),
      head: result.history.latestSequence,
      older: result.history.hasOlderEvents,
    }).toEqual({
      events: [reacting.event, deleted.event].map((event) => ({
        id: event.id,
        type: "message_created",
        sequence: event.sequence.toString(),
        broadcast: event.broadcastSequence!.toString(),
      })),
      head: patches.at(-1)!.sequence.toString(),
      older: false,
    })
    expect(result.history.events.map((event) => event.payload)).toMatchObject([
      { contentMarkdown: "reacted message", reactions: { "👍": [viewer] } },
      { deletedAt: expect.any(String) },
    ])
  })

  test("should deny a local thread whose public root belongs to another workspace", async () => {
    const foreignRoot = await seedChannel("public", { inWorkspace: workspaceId() })
    const localThread = await seedThread(foreignRoot, messageId())
    await seedMessage(localThread, "must not be disclosed")
    expect(await service.get(workspace, viewer, [localThread])).toEqual({
      results: [{ streamId: localThread, status: 403, code: "FORBIDDEN" }],
    })
  })

  test("should retain a hidden-only head and order sequences beyond JS integer precision", async () => {
    const hiddenOnly = await seedChannel("public")
    const largeSequences = await seedChannel("public")
    const hidden = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: workspace,
      streamId: hiddenOnly,
      eventType: AUTHOR_SCOPED_EVENT_TYPES[0],
      payload: {},
      actorId: other,
    })
    const large = await StreamEventRepository.insertMany(
      pool,
      [0, 1, 2].map(() => ({
        id: eventId(),
        workspaceId: workspace,
        streamId: largeSequences,
        eventType: "member_joined" as const,
        payload: {},
      }))
    )
    for (const [index, event] of large.entries()) {
      await pool.query("UPDATE stream_events SET sequence = $2 WHERE id = $1", [
        event.id,
        (9007199254740992n + BigInt(index)).toString(),
      ])
    }
    const results = (await service.get(workspace, viewer, [hiddenOnly, largeSequences])).results.map(okHistory)
    expect({
      hidden: {
        events: results[0].history.events,
        head: results[0].history.latestSequence,
        older: results[0].history.hasOlderEvents,
      },
      large: results[1].history.events.map((event) => ({ id: event.id, sequence: event.sequence })),
      head: results[1].history.latestSequence,
    }).toEqual({
      hidden: { events: [], head: hidden.sequence.toString(), older: false },
      large: large.map((event, index) => ({ id: event.id, sequence: (9007199254740992n + BigInt(index)).toString() })),
      head: "9007199254740994",
    })
  })

  test("should timestamp the snapshot before its first database read", async () => {
    let firstReadAt: number | undefined
    const original = pool.query.bind(pool)
    const spy = spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
      if (firstReadAt === undefined) {
        firstReadAt = Date.now()
        await Bun.sleep(10)
      }
      return (original as (...args: unknown[]) => unknown)(...args)
    }) as typeof pool.query)
    try {
      const [result] = (await service.get(workspace, viewer, [publicRoot])).results.map(okHistory)
      expect(Date.parse(result.history.snapshotAt!) <= firstReadAt!).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("should reject the whole batch on unexpected enrichment failures", async () => {
    const failure = new Error("transient preview database failure")
    const spy = spyOn(previews, "getPreviewsForMessages").mockRejectedValueOnce(failure)
    try {
      await expect(service.get(workspace, viewer, [publicRoot, deniedRoot])).rejects.toThrow(failure.message)
    } finally {
      spy.mockRestore()
    }
  })

  test("should accept only nonempty bounded unique prefixed stream IDs", () => {
    expect(
      [
        { streamIds: [] },
        { streamIds: [publicRoot, publicRoot] },
        { streamIds: ["not-a-stream"] },
        { streamIds: Array.from({ length: STREAM_PREVIEW_HISTORY_MAX_STREAMS + 1 }, () => streamId()) },
      ].map((body) => previewHistorySchema.safeParse(body).success)
    ).toEqual([false, false, false, false])
    expect(previewHistorySchema.parse({ streamIds: [publicRoot, thread] })).toEqual({ streamIds: [publicRoot, thread] })
  })
})
