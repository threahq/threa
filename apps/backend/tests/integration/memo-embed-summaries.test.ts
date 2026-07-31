/**
 * `MemoRepository.findEmbedSummaries` — the room-uniform access predicate that
 * decides which referenced memos get their card content put on a message
 * payload.
 *
 * This is a security boundary, and it is one the codebase did not have before:
 * `strip-inaccessible-agent-refs` says outright that per-recipient memo
 * visibility "is still enforced at render time by the memo-detail endpoint, so
 * we deliberately don't re-check stream reach here." Once the card renders from
 * the payload there is no render-time fetch left to enforce it, so this query
 * IS the check. Asserting its SQL text would prove nothing about any of that
 * (INV-68) — every case below seeds real rows and reads back what the statement
 * actually returns.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { MemoRepository } from "../../src/features/memos"
import { userId, workspaceId, streamId, messageId, memoId } from "../../src/lib/id"

describe("MemoRepository.findEmbedSummaries", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string

  /** The stream whose messages cite the memos — the "room" the payload goes to. */
  let citingRoot: string
  let publicChannel: string
  let privateChannel: string
  /** A thread of `citingRoot`. */
  let citingThread: string
  /**
   * A thread whose OWN row says `visibility = 'public'` while its root is
   * private — what a thread of a channel that was later privatized looks like,
   * since a thread's visibility is copied at creation and never re-synced.
   */
  let stalePublicThread: string

  let sequence = 1n

  async function seedMemo(
    sourceStreamId: string,
    options: { title: string; scope?: "workspace" | "user"; tags?: string[] }
  ): Promise<string> {
    const id = memoId()
    const msgId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: msgId,
        streamId: sourceStreamId,
        sequence: sequence++,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id,
        workspaceId: testWorkspaceId,
        memoType: "message",
        sourceMessageId: msgId,
        title: options.title,
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [msgId],
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: options.tags ?? ["settings"],
        status: "active",
        scope: options.scope ?? "workspace",
        scopeUserId: options.scope === "user" ? testUserId : null,
      })
    })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    testUserId = userId()
    citingRoot = streamId()
    publicChannel = streamId()
    privateChannel = streamId()
    citingThread = streamId()
    stalePublicThread = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Embed Summaries",
        slug: `memo-embed-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id

      for (const [id, visibility] of [
        [citingRoot, "private"],
        [publicChannel, "public"],
        [privateChannel, "private"],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility,
          slug: `s-${id.slice(-8)}`,
          createdBy: testUserId,
        })
      }

      await StreamRepository.insert(client, {
        id: citingThread,
        workspaceId: testWorkspaceId,
        type: "thread",
        visibility: "private",
        parentStreamId: citingRoot,
        rootStreamId: citingRoot,
        createdBy: testUserId,
      })
      await StreamRepository.insert(client, {
        id: stalePublicThread,
        workspaceId: testWorkspaceId,
        type: "thread",
        // The stale copy: the row says public, the root says private.
        visibility: "public",
        parentStreamId: privateChannel,
        rootStreamId: privateChannel,
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("summarises a memo sourced in the citing stream itself", async () => {
    const id = await seedMemo(citingRoot, { title: "Theme switch", tags: ["settings", "preferences"] })

    const summaries = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)

    expect(summaries.get(id)).toEqual({
      memoId: id,
      title: "Theme switch",
      knowledgeType: "decision",
      memoType: "message",
      tags: ["settings", "preferences"],
      updatedAt: expect.any(String),
    })
  })

  test("summarises a memo sourced in a thread of the citing stream", async () => {
    const id = await seedMemo(citingThread, { title: "Decided in a thread" })

    const summaries = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)

    expect(summaries.get(id)?.title).toBe("Decided in a thread")
  })

  test("summarises a memo sourced in a public stream, cited anywhere", async () => {
    const id = await seedMemo(publicChannel, { title: "Public knowledge" })

    const summaries = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)

    expect(summaries.get(id)?.title).toBe("Public knowledge")
  })

  test("withholds a memo sourced in a private stream the room is not", async () => {
    const id = await seedMemo(privateChannel, { title: "Acquisition target" })

    const summaries = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)

    expect(summaries.has(id)).toBe(false)
  })

  // The trap this predicate exists for. The thread's own row says `public`
  // because it was created while its root was; resolving to the root is what
  // keeps a privatized channel's knowledge off a public payload.
  test("withholds a memo sourced in a stale-public thread of a private root", async () => {
    const id = await seedMemo(stalePublicThread, { title: "Privatized after the thread was made" })

    const viaThread = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)
    expect(viaThread.has(id)).toBe(false)

    // And it IS reachable from its own root, so the row is genuinely there —
    // the case above is the predicate working, not an empty seed.
    const viaOwnRoot = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], privateChannel)
    expect(viaOwnRoot.get(id)?.title).toBe("Privatized after the thread was made")
  })

  test("withholds a user-scoped memo even from its own stream", async () => {
    const id = await seedMemo(citingRoot, { title: "Private tier", scope: "user" })

    const summaries = await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [id], citingRoot)

    expect(summaries.has(id)).toBe(false)
  })

  test("withholds ids from another workspace and unknown ids", async () => {
    const otherWorkspace = workspaceId()
    const otherStream = streamId()
    const otherUser = userId()
    let otherUserId = otherUser
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: otherWorkspace,
        name: "Other",
        slug: `other-${otherWorkspace}`,
        createdBy: otherUser,
      })
      otherUserId = (await addTestMember(client, otherWorkspace, otherUser)).id
      await StreamRepository.insert(client, {
        id: otherStream,
        workspaceId: otherWorkspace,
        type: "channel",
        visibility: "public",
        slug: `s-${otherStream.slice(-8)}`,
        createdBy: otherUserId,
      })
    })
    const foreignMsg = messageId()
    const foreignMemo = memoId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: foreignMsg,
        streamId: otherStream,
        sequence: sequence++,
        authorId: otherUserId,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id: foreignMemo,
        workspaceId: otherWorkspace,
        memoType: "message",
        sourceMessageId: foreignMsg,
        title: "Someone else's",
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [foreignMsg],
        participantIds: [otherUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
      })
    })

    const summaries = await MemoRepository.findEmbedSummaries(
      pool,
      testWorkspaceId,
      [foreignMemo, memoId()],
      citingRoot
    )

    expect(summaries.size).toBe(0)
  })

  test("resolves a batch in one call, dropping only what the predicate rejects", async () => {
    const allowed = await seedMemo(citingRoot, { title: "Allowed" })
    const alsoAllowed = await seedMemo(publicChannel, { title: "Also allowed" })
    const withheld = await seedMemo(privateChannel, { title: "Withheld" })

    const summaries = await MemoRepository.findEmbedSummaries(
      pool,
      testWorkspaceId,
      [allowed, withheld, alsoAllowed],
      citingRoot
    )

    expect([...summaries.keys()].sort()).toEqual([allowed, alsoAllowed].sort())
  })

  test("returns an empty map for no ids without touching the database", async () => {
    expect(await MemoRepository.findEmbedSummaries(pool, testWorkspaceId, [], citingRoot)).toEqual(new Map())
  })
})
