/**
 * Sync-log entries are sanitized at SERVE time.
 *
 * Stored payloads snapshot access-gated content (hydrated share slots, memo
 * summaries) at write time and replay for up to the retention window —
 * without re-resolution, a viewer catching up after a source went private
 * receives content every live path now withholds.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes, Visibilities, sharedMessageSlotKey } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { MessageRepository, MessageVersionRepository } from "../../src/features/messaging"
import { MemoRepository } from "../../src/features/memos"
import { sanitizeSyncEntries, type SyncLogEntry } from "../../src/features/sync"
import { userId, workspaceId, streamId, messageId, memoId, messageVersionId } from "../../src/lib/id"

describe("sanitizeSyncEntries", () => {
  let pool: Pool
  let testWorkspaceId: string
  let viewer: string
  let citingChannel: string
  let privatizedSource: string
  let privateMemo: string
  let readableMemo: string
  let privateSharedMsg: string
  let readableSharedMsg: string
  let sequence = 1n

  function entry(eventType: string, payload: unknown): SyncLogEntry {
    return { syncId: sequence++, eventType, payload, createdAt: new Date() } as SyncLogEntry
  }

  const summaryOf = (memo: string, title: string) => ({
    memoId: memo,
    title,
    knowledgeType: "decision",
    memoType: "message",
    tags: [] as string[],
    updatedAt: new Date().toISOString(),
  })

  const staleOkSlot = (msgId: string) => ({
    type: "sharedMessage" as const,
    state: "ok" as const,
    messageId: msgId,
    streamId: "stream_stale",
    authorId: viewer,
    authorType: "user",
    authorName: "Stale",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "stale snapshot",
    editedAt: null,
    createdAt: new Date(),
    attachments: [],
  })

  async function seedMemo(sourceStreamId: string, title: string): Promise<string> {
    const id = memoId()
    const msgId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: msgId,
        streamId: sourceStreamId,
        sequence: sequence++,
        authorId: viewer,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: msgId,
        title,
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [msgId],
        participantIds: [viewer],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    viewer = userId()
    citingChannel = streamId()
    privatizedSource = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Sync Sanitize",
        slug: `sync-sanitize-${testWorkspaceId}`,
        createdBy: viewer,
      })
      viewer = (await addTestMember(client, testWorkspaceId, viewer)).id
      for (const [id, visibility] of [
        [citingChannel, "private"],
        [privatizedSource, "public"],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: visibility as (typeof Visibilities)[keyof typeof Visibilities],
          slug: `s-${id.slice(-8)}`,
          createdBy: viewer,
        })
      }
      await StreamMemberRepository.insert(client, citingChannel, viewer)
    })

    privateMemo = await seedMemo(privatizedSource, "Was public when logged")
    readableMemo = await seedMemo(citingChannel, "Cited in its own room")

    // Shared-message sources: one in the room the viewer belongs to, one in
    // the stream about to go private.
    privateSharedMsg = messageId()
    readableSharedMsg = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: privateSharedMsg,
        streamId: privatizedSource,
        sequence: sequence++,
        authorId: viewer,
        authorType: "user",
        ...testMessageContent("shared while public"),
      })
      await MessageRepository.insert(client, {
        id: readableSharedMsg,
        streamId: citingChannel,
        sequence: sequence++,
        authorId: viewer,
        authorType: "user",
        ...testMessageContent("current source content"),
      })
    })

    await pool.query(`UPDATE streams SET visibility = 'private' WHERE id = $1`, [privatizedSource])
  })

  afterAll(async () => {
    await pool.end()
  })

  test("drops a memo:updated entry whose room may no longer see the memo", async () => {
    const withheld = entry("memo:updated", {
      workspaceId: testWorkspaceId,
      streamId: citingChannel,
      memoId: privateMemo,
      summary: summaryOf(privateMemo, "Was public when logged"),
    })
    const kept = entry("memo:updated", {
      workspaceId: testWorkspaceId,
      streamId: citingChannel,
      memoId: readableMemo,
      summary: summaryOf(readableMemo, "A title the log froze"),
    })

    const out = await sanitizeSyncEntries(pool, {
      workspaceId: testWorkspaceId,
      userId: viewer,
      entries: [withheld, kept],
    })

    expect(out).toHaveLength(1)
    const payload = out[0].payload as { summary: { memoId: string; title: string } }
    expect(payload.summary.memoId).toBe(readableMemo)
    // Re-resolved, not replayed: the serve returns the memo's CURRENT title.
    expect(payload.summary.title).toBe("Cited in its own room")
  })

  test("empties stale memoEmbeds inside a replayed message_created payload", async () => {
    const e = entry("message:created", {
      workspaceId: testWorkspaceId,
      streamId: citingChannel,
      event: {
        id: "evt_1",
        eventType: "message_created",
        payload: { messageId: messageId(), memoEmbeds: [summaryOf(privateMemo, "Was public when logged")] },
      },
    })

    const out = await sanitizeSyncEntries(pool, { workspaceId: testWorkspaceId, userId: viewer, entries: [e] })

    const eventPayload = (out[0].payload as { event: { payload: { memoEmbeds: unknown[] } } }).event.payload
    expect(eventPayload.memoEmbeds).toEqual([])
  })

  test("re-hydrates slots per viewer: withheld sources turn private, readable ones refresh", async () => {
    const e = entry("message:created", {
      workspaceId: testWorkspaceId,
      streamId: citingChannel,
      event: { id: "evt_2", eventType: "message_created", payload: { messageId: messageId() } },
      slots: {
        [sharedMessageSlotKey(privateSharedMsg)]: staleOkSlot(privateSharedMsg),
        [sharedMessageSlotKey(readableSharedMsg)]: staleOkSlot(readableSharedMsg),
      },
    })

    const out = await sanitizeSyncEntries(pool, { workspaceId: testWorkspaceId, userId: viewer, entries: [e] })

    const slots = (out[0].payload as { slots: Record<string, { state: string; contentMarkdown?: string }> }).slots
    expect(slots[sharedMessageSlotKey(privateSharedMsg)].state).toBe("private")
    expect(slots[sharedMessageSlotKey(readableSharedMsg)]).toMatchObject({
      state: "ok",
      contentMarkdown: "current source content",
    })
  })

  test("re-hydrates a pinned slot at its pinned revision, not the source's current body", async () => {
    const pinnedSource = messageId()
    const pinned = testMessageContent("body when it was shared")
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: pinnedSource,
        streamId: citingChannel,
        sequence: sequence++,
        authorId: viewer,
        authorType: "user",
        ...testMessageContent("body as it reads now"),
      })
    })
    await MessageVersionRepository.insert(pool, {
      id: messageVersionId(),
      messageId: pinnedSource,
      versionNumber: 1,
      contentJson: pinned.contentJson,
      contentMarkdown: pinned.contentMarkdown,
      editedBy: viewer,
    })
    await pool.query(`UPDATE messages SET revision = 2 WHERE id = $1`, [pinnedSource])

    const pinnedKey = sharedMessageSlotKey(pinnedSource, 1)
    const e = entry("message:created", {
      workspaceId: testWorkspaceId,
      streamId: citingChannel,
      event: { id: "evt_pinned", eventType: "message_created", payload: { messageId: messageId() } },
      slots: { [pinnedKey]: staleOkSlot(pinnedSource) },
    })

    const out = await sanitizeSyncEntries(pool, { workspaceId: testWorkspaceId, userId: viewer, entries: [e] })

    const slots = (out[0].payload as { slots: Record<string, Record<string, unknown>> }).slots
    expect(slots[pinnedKey]).toMatchObject({
      state: "ok",
      contentMarkdown: "body when it was shared",
      version: 1,
      currentRevision: 2,
    })
  })

  test("entries with no gated content pass through untouched, same array", async () => {
    // Includes a plain edit: edited payloads ALWAYS carry memoEmbeds (empty
    // included), and an empty array must not knock the page off the
    // zero-query identity path.
    const entries = [
      entry("stream:read_state_updated", { workspaceId: testWorkspaceId, streamId: citingChannel }),
      entry("message:edited", {
        workspaceId: testWorkspaceId,
        streamId: citingChannel,
        event: {
          id: "evt_plain_edit",
          eventType: "message_edited",
          payload: { messageId: messageId(), memoEmbeds: [] },
        },
      }),
    ]
    const out = await sanitizeSyncEntries(pool, { workspaceId: testWorkspaceId, userId: viewer, entries })
    expect(out).toBe(entries)
  })
})
