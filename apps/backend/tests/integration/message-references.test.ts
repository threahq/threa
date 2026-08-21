/**
 * Server-side reference resolution: the pass that pins every `quoteReply` and
 * `sharedMessage` node to a source revision + span, derives the quote body from
 * it, and rejects a reference it cannot honour.
 *
 * Exercised through the real create/edit paths against the real schema
 * (INV-68) — the pinned bodies come out of `message_versions`, and the quote
 * snippets out of the same slicing the frontend chip will use.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { MessageReferenceErrorCodes, sharedMessageSlotKey, type JSONContent, type SharedMessageRef } from "@threa/types"

import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import {
  EventService,
  MessageRepository,
  collectSharedMessageRefs,
  hydrateSharedMessageRefs,
  sliceReferenceContent,
} from "../../src/features/messaging"
import { userId, workspaceId, streamId } from "../../src/lib/id"

function docOf(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

function quoteNode(attrs: Record<string, unknown>): JSONContent {
  return {
    type: "quoteReply",
    attrs: {
      authorName: "Someone Else",
      authorId: "usr_forged",
      actorType: "user",
      snippet: "",
      ...attrs,
    },
  }
}

function quoteAttrs(message: { contentJson: JSONContent }): Record<string, unknown> {
  const node = (message.contentJson.content ?? []).find((n) => n.type === "quoteReply")
  return (node?.attrs ?? {}) as Record<string, unknown>
}

function shareAttrs(message: { contentJson: JSONContent }): Record<string, unknown> {
  const node = (message.contentJson.content ?? []).find((n) => n.type === "sharedMessage")
  return (node?.attrs ?? {}) as Record<string, unknown>
}

async function expectReferenceError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { status?: number; code?: string }
  )
  expect({ status: error?.status, code: error?.code }).toEqual({ status: 400, code })
}

describe("message reference resolution", () => {
  let pool: Pool
  let eventService: EventService
  let testWorkspaceId: string
  let author: string
  let source: string
  let target: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    testWorkspaceId = workspaceId()
    author = userId()
    source = streamId()
    target = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Message References",
        slug: `message-references-${testWorkspaceId}`,
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
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedEditedSource() {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: source,
      authorId: author,
      authorType: "user",
      contentJson: docOf("first body"),
      contentMarkdown: "first body",
    })
    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: message.id,
      streamId: source,
      actorId: author,
      contentJson: docOf("second body"),
      contentMarkdown: "second body",
    })
    return message
  }

  test("(a) a quote pinned to an older revision stores that revision's slice", async () => {
    const src = await seedEditedSource()
    const range = { from: 1, to: 6 }

    const quoting = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: source,
      authorId: author,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [quoteNode({ messageId: src.id, streamId: source, version: 1, range }), ...docOf("agreed").content!],
      },
      contentMarkdown: "agreed",
    })

    const stored = await MessageRepository.findById(pool, quoting.id)
    expect(quoteAttrs(stored!)).toEqual({
      messageId: src.id,
      streamId: source,
      authorName: expect.any(String),
      authorId: author,
      actorType: "user",
      snippet: sliceReferenceContent(docOf("first body"), range).contentMarkdown,
      version: 1,
      range,
    })
    expect(quoteAttrs(stored!).snippet).toBe("first")
  })

  test("(b) a forged snippet is replaced by the slice the range names", async () => {
    const src = await seedEditedSource()
    const quoting = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: source,
      authorId: author,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [
          quoteNode({
            messageId: src.id,
            streamId: source,
            version: 2,
            range: { from: 1, to: 7 },
            snippet: "I never said this",
            authorName: "Impostor",
          }),
        ],
      },
      contentMarkdown: "> I never said this",
    })

    const stored = await MessageRepository.findById(pool, quoting.id)
    expect(quoteAttrs(stored!)).toMatchObject({ snippet: "second", authorId: author, version: 2 })
  })

  test("(c) a version the source never had is rejected", async () => {
    const src = await seedEditedSource()
    await expectReferenceError(
      eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: source,
        authorId: author,
        authorType: "user",
        contentJson: { type: "doc", content: [quoteNode({ messageId: src.id, streamId: source, version: 99 })] },
        contentMarkdown: "> nope",
      }),
      MessageReferenceErrorCodes.VERSION_NOT_FOUND
    )
  })

  test("(d) a range outside the pinned document is rejected", async () => {
    const src = await seedEditedSource()
    await expectReferenceError(
      eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: source,
        authorId: author,
        authorType: "user",
        contentJson: {
          type: "doc",
          content: [quoteNode({ messageId: src.id, streamId: source, version: 1, range: { from: 0, to: 9999 } })],
        },
        contentMarkdown: "> nope",
      }),
      MessageReferenceErrorCodes.RANGE_INVALID
    )
  })

  describe("(e) a rangeless quote is located from its snippet", () => {
    async function quoteWithSnippet(snippet: string) {
      const src = await seedEditedSource()
      const quoting = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: source,
        authorId: author,
        authorType: "user",
        contentJson: { type: "doc", content: [quoteNode({ messageId: src.id, streamId: source, snippet })] },
        contentMarkdown: `> ${snippet}`,
      })
      return quoteAttrs((await MessageRepository.findById(pool, quoting.id))!)
    }

    test("text that exists in the current revision yields its range", async () => {
      expect(await quoteWithSnippet("second")).toMatchObject({ version: 2, range: { from: 1, to: 7 } })
    })

    test("a snippet covering the whole message stays whole", async () => {
      expect(await quoteWithSnippet("second body")).toMatchObject({ version: 2, range: null })
    })

    test("text that is nowhere in the message is rejected", async () => {
      const src = await seedEditedSource()
      await expectReferenceError(
        eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: source,
          authorId: author,
          authorType: "user",
          contentJson: {
            type: "doc",
            content: [quoteNode({ messageId: src.id, streamId: source, snippet: "never written anywhere" })],
          },
          contentMarkdown: "> never written anywhere",
        }),
        MessageReferenceErrorCodes.RANGE_NOT_FOUND
      )
    })
  })

  test("(f) a quote of a message that does not exist is rejected", async () => {
    await expectReferenceError(
      eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: source,
        authorId: author,
        authorType: "user",
        contentJson: { type: "doc", content: [quoteNode({ messageId: "msg_nope", streamId: source })] },
        contentMarkdown: "> nope",
      }),
      MessageReferenceErrorCodes.SOURCE_NOT_FOUND
    )
  })

  describe("(g) share hydration serves the pin", () => {
    async function hydrateFor(message: { contentJson: JSONContent }) {
      const refs = new Map<string, SharedMessageRef>()
      collectSharedMessageRefs(message.contentJson, refs)
      return hydrateSharedMessageRefs(pool, testWorkspaceId, author, refs.values())
    }

    test("a share pinned to a revision + range serves that slice with the current revision alongside", async () => {
      const src = await seedEditedSource()
      const range = { from: 1, to: 6 }
      const sharing = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: target,
        authorId: author,
        authorType: "user",
        contentJson: {
          type: "doc",
          content: [{ type: "sharedMessage", attrs: { messageId: src.id, streamId: source, version: 1, range } }],
        },
        contentMarkdown: "look at this",
      })

      const stored = (await MessageRepository.findById(pool, sharing.id))!
      expect(shareAttrs(stored)).toMatchObject({ version: 1, range })

      const slots = await hydrateFor(stored)
      expect(slots[sharedMessageSlotKey(src.id, 1, range)]).toMatchObject({
        state: "ok",
        contentMarkdown: "first",
        version: 1,
        currentRevision: 2,
        range,
        attachments: [],
      })
    })

    test("an unranged share is pinned to the current revision and keeps its attachments row", async () => {
      const src = await seedEditedSource()
      const sharing = await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: target,
        authorId: author,
        authorType: "user",
        contentJson: {
          type: "doc",
          content: [{ type: "sharedMessage", attrs: { messageId: src.id, streamId: source } }],
        },
        contentMarkdown: "look at this",
      })

      const stored = (await MessageRepository.findById(pool, sharing.id))!
      expect(shareAttrs(stored)).toMatchObject({ version: 2, range: null })

      const slots = await hydrateFor(stored)
      expect(slots[sharedMessageSlotKey(src.id, 2)]).toMatchObject({
        state: "ok",
        contentMarkdown: "second body",
        version: 2,
        currentRevision: 2,
        range: null,
        attachments: [],
      })
    })

    test("a legacy unpinned node still hydrates under the bare key", async () => {
      const src = await seedEditedSource()
      const legacy: JSONContent = {
        type: "doc",
        content: [{ type: "sharedMessage", attrs: { messageId: src.id, streamId: source } }],
      }
      const slots = await hydrateFor({ contentJson: legacy })
      expect(slots[sharedMessageSlotKey(src.id)]).toMatchObject({
        state: "ok",
        contentMarkdown: "second body",
        version: 2,
        currentRevision: 2,
      })
    })
  })

  test("(h) editing around a pinned quote leaves the quote byte-identical", async () => {
    const src = await seedEditedSource()
    const range = { from: 1, to: 6 }
    const quoting = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: source,
      authorId: author,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [quoteNode({ messageId: src.id, streamId: source, version: 1, range }), ...docOf("agreed").content!],
      },
      contentMarkdown: "agreed",
    })
    const before = quoteAttrs((await MessageRepository.findById(pool, quoting.id))!)

    // The source moves on; the pinned quote must not follow it.
    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: src.id,
      streamId: source,
      actorId: author,
      contentJson: docOf("third body"),
      contentMarkdown: "third body",
    })

    const stored = (await MessageRepository.findById(pool, quoting.id))!
    await eventService.editMessageInternal({
      workspaceId: testWorkspaceId,
      messageId: quoting.id,
      streamId: source,
      actorId: author,
      contentJson: { type: "doc", content: [...stored.contentJson.content!, ...docOf("still agreed").content!] },
      contentMarkdown: "agreed\n\nstill agreed",
    })

    const after = quoteAttrs((await MessageRepository.findById(pool, quoting.id))!)
    expect(after).toEqual(before)
  })
})
