/**
 * The `message-reference-pins` backfill against the real schema (INV-68).
 *
 * Legacy rows are inserted through the repository rather than the write path,
 * because the write path now pins everything — an unpinned node can only exist
 * as stored history, which is exactly what this backfill has to converge.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { JSONContent } from "@threa/types"

import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import {
  EventService,
  MessageRepository,
  MESSAGE_REFERENCE_PINS_BACKFILL_NAME,
  registerMessageReferencePinsBackfill,
  sliceReferenceContent,
} from "../../src/features/messaging"
import { getBackfill } from "../../src/lib/backfill"
import { messageId, userId, workspaceId, streamId } from "../../src/lib/id"

function docOf(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

/** A quote node as the pre-pinning client wrote it: a snippet and no version. */
function legacyQuote(sourceId: string, sourceStreamId: string, snippet: string, author: string): JSONContent {
  return {
    type: "quoteReply",
    attrs: { messageId: sourceId, streamId: sourceStreamId, authorName: "Author", authorId: author, snippet },
  }
}

function legacyShare(sourceId: string, sourceStreamId: string): JSONContent {
  return { type: "sharedMessage", attrs: { messageId: sourceId, streamId: sourceStreamId } }
}

function referenceAttrs(content: JSONContent | null | undefined, type: string): Record<string, unknown> {
  const node = (content?.content ?? []).find((n) => n.type === type)
  return (node?.attrs ?? {}) as Record<string, unknown>
}

describe("message-reference-pins backfill", () => {
  let pool: Pool
  let ctx: { pool: Pool }
  let eventService: EventService
  let testWorkspaceId: string
  let author: string
  let source: string
  let target: string
  let sourceMessageId: string
  let locatableQuoteId: string
  let unlocatableQuoteId: string
  let shareId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ctx = { pool }
    eventService = new EventService(pool)
    testWorkspaceId = workspaceId()
    author = userId()
    source = streamId()
    target = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Reference Pins",
        slug: `reference-pins-${testWorkspaceId}`,
        createdBy: author,
      })
      author = (await addTestMember(client, testWorkspaceId, author)).id
      for (const [id, label] of [
        [source, "source"],
        [target, "target"],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          slug: `${label}-${id.slice(-8)}`,
          createdBy: author,
        })
        await StreamMemberRepository.insert(client, id, author)
      }
    })

    const src = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: source,
      authorId: author,
      authorType: "user",
      contentJson: docOf("first body"),
      contentMarkdown: "first body",
    })
    sourceMessageId = src.id
    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: src.id,
      streamId: source,
      actorId: author,
      contentJson: docOf("second body"),
      contentMarkdown: "second body",
    })

    locatableQuoteId = messageId()
    unlocatableQuoteId = messageId()
    shareId = messageId()
    const legacyRows: Array<{ id: string; sequence: bigint; content: JSONContent; markdown: string }> = [
      {
        id: locatableQuoteId,
        sequence: 900001n,
        content: {
          type: "doc",
          content: [legacyQuote(sourceMessageId, source, "first", author), ...docOf("agreed").content!],
        },
        markdown: "agreed",
      },
      {
        id: unlocatableQuoteId,
        sequence: 900002n,
        content: {
          type: "doc",
          content: [legacyQuote(sourceMessageId, source, "words nobody ever wrote", author), ...docOf("hm").content!],
        },
        markdown: "hm",
      },
      {
        id: shareId,
        sequence: 900003n,
        content: { type: "doc", content: [legacyShare(sourceMessageId, source), ...docOf("look").content!] },
        markdown: "look",
      },
    ]
    await withTransaction(pool, async (client) => {
      for (const row of legacyRows) {
        await MessageRepository.insert(client, {
          id: row.id,
          streamId: target,
          sequence: row.sequence,
          authorId: author,
          authorType: "user",
          contentJson: row.content,
          contentMarkdown: row.markdown,
        })
      }
    })

    registerMessageReferencePinsBackfill()
    await runBackfill()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function runBackfill(): Promise<void> {
    const definition = getBackfill(MESSAGE_REFERENCE_PINS_BACKFILL_NAME)
    if (!definition) throw new Error("message-reference-pins backfill is not registered")
    for (const chunk of await definition.plan(ctx, testWorkspaceId)) {
      await definition.processChunk(ctx, testWorkspaceId, chunk)
    }
  }

  test("a legacy quote pins to the revision its snippet came from, with a re-derived body", async () => {
    const stored = await MessageRepository.findById(pool, locatableQuoteId)
    const range = { from: 1, to: 6 }
    expect(referenceAttrs(stored?.contentJson, "quoteReply")).toEqual({
      messageId: sourceMessageId,
      streamId: source,
      authorName: "Author",
      authorId: author,
      snippet: sliceReferenceContent(docOf("first body"), range).contentMarkdown,
      version: 1,
      range,
    })
  })

  test("a legacy quote whose snippet is in no revision stays unpinned", async () => {
    const stored = await MessageRepository.findById(pool, unlocatableQuoteId)

    expect(referenceAttrs(stored?.contentJson, "quoteReply")).toEqual({
      messageId: sourceMessageId,
      streamId: source,
      authorName: "Author",
      authorId: author,
      snippet: "words nobody ever wrote",
    })
  })

  test("a legacy share pins to the source's current revision, whole", async () => {
    const stored = await MessageRepository.findById(pool, shareId)

    expect(referenceAttrs(stored?.contentJson, "sharedMessage")).toEqual({
      messageId: sourceMessageId,
      streamId: source,
      version: 2,
      range: null,
    })
  })

  test("re-running the backfill changes nothing", async () => {
    const ids = [locatableQuoteId, unlocatableQuoteId, shareId]
    const before = await Promise.all(ids.map((id) => MessageRepository.findById(pool, id)))

    await runBackfill()

    const after = await Promise.all(ids.map((id) => MessageRepository.findById(pool, id)))
    expect(after.map((m) => ({ contentJson: m?.contentJson, contentMarkdown: m?.contentMarkdown }))).toEqual(
      before.map((m) => ({ contentJson: m?.contentJson, contentMarkdown: m?.contentMarkdown }))
    )
  })
})
