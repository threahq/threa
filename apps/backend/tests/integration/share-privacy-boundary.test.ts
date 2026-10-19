/**
 * The share privacy check asks who can read the target and cannot read the source, with both sides
 * decided by the stream access rule (INV-62) — not who holds a `stream_members` row. A thread holds
 * almost no rows of its own, and an open channel's readers hold none.
 *
 * Exercised through the real create path against the real schema (INV-68).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ShareErrorCodes, type JSONContent } from "@threahq/types"

import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository, countReadersWithoutAccess } from "../../src/features/streams"
import { EventService, SharedMessageRepository } from "../../src/features/messaging"
import { userId, workspaceId, streamId } from "../../src/lib/id"

function paragraphOf(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

function docOf(text: string): JSONContent {
  return { type: "doc", content: [paragraphOf(text)] }
}

describe("share privacy boundary", () => {
  let pool: Pool
  let eventService: EventService
  let ws: string
  let alice: string
  let bob: string
  let guest: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    ws = workspaceId()
    const owner = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Share Privacy",
        slug: `share-privacy-${ws}`,
        createdBy: owner,
      })
      alice = (await addTestMember(client, ws, userId())).id
      bob = (await addTestMember(client, ws, userId())).id
      guest = (await addTestMember(client, ws, userId(), "guest")).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedStream(
    visibility: "public" | "private" | "guest_public",
    members: string[],
    thread?: { rootStreamId: string }
  ): Promise<string> {
    const id = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id,
        workspaceId: ws,
        type: thread ? "thread" : "channel",
        visibility,
        ...(thread ? { parentStreamId: thread.rootStreamId, rootStreamId: thread.rootStreamId } : {}),
        slug: `s-${id.slice(-8)}`,
        createdBy: alice,
      })
      for (const member of members) {
        await StreamMemberRepository.insert(client, ws, id, member)
      }
    })
    return id
  }

  async function seedMessage(stream: string) {
    return eventService.createMessage({
      workspaceId: ws,
      streamId: stream,
      authorId: alice,
      authorType: "user",
      contentJson: docOf("the source"),
      contentMarkdown: "the source",
    })
  }

  function shareInto(
    target: string,
    node: JSONContent,
    extras: { confirmedPrivacyWarning?: boolean } = {}
  ): Promise<{ id: string }> {
    return eventService.createMessage({
      workspaceId: ws,
      streamId: target,
      authorId: alice,
      authorType: "user",
      contentJson: { type: "doc", content: [node] },
      contentMarkdown: "shared",
      ...extras,
    })
  }

  function quoteOf(source: string, messageId: string): JSONContent {
    return {
      type: "quoteReply",
      attrs: { messageId, streamId: source, authorId: alice, authorName: "Alice", actorType: "user", snippet: "" },
    }
  }

  function pointerTo(source: string, messageId: string): JSONContent {
    return { type: "sharedMessage", attrs: { messageId, streamId: source } }
  }

  function editTo(target: string, messageId: string, ...nodes: JSONContent[]) {
    return eventService.editMessageInternal({
      workspaceId: ws,
      messageId,
      streamId: target,
      contentJson: { type: "doc", content: nodes },
      contentMarkdown: "edited",
      actorId: alice,
    })
  }

  async function expectConfirmationRequired(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
    })
  }

  async function sharesOf(sourceMessageId: string) {
    const rows = await SharedMessageRepository.listBySourceMessageIds(pool, ws, [sourceMessageId])
    return rows.map((row) => ({ shareMessageId: row.shareMessageId, targetStreamId: row.targetStreamId }))
  }

  test("quoting a private message into a thread whose channel holds a non-reader asks, and a confirmed send lands", async () => {
    const leadership = await seedStream("private", [alice])
    const product = await seedStream("private", [alice, bob])
    const thread = await seedStream("private", [alice], { rootStreamId: product })
    const source = await seedMessage(leadership)

    await expectConfirmationRequired(shareInto(thread, quoteOf(leadership, source.id)))

    const confirmed = await shareInto(thread, quoteOf(leadership, source.id), { confirmedPrivacyWarning: true })
    expect(await sharesOf(source.id)).toEqual([{ shareMessageId: confirmed.id, targetStreamId: thread }])
  })

  test("sharing a private message into a thread whose channel holds a non-reader asks", async () => {
    const leadership = await seedStream("private", [alice])
    const product = await seedStream("private", [alice, bob])
    const thread = await seedStream("private", [alice], { rootStreamId: product })
    const source = await seedMessage(leadership)

    await expectConfirmationRequired(shareInto(thread, pointerTo(leadership, source.id)))
  })

  test("sharing a private message into a public channel asks even when no other member row exists", async () => {
    const leadership = await seedStream("private", [alice])
    const open = await seedStream("public", [alice])
    const source = await seedMessage(leadership)

    await expectConfirmationRequired(shareInto(open, pointerTo(leadership, source.id)))
  })

  test("sharing a thread message into its own channel needs no confirmation", async () => {
    const product = await seedStream("private", [alice, bob])
    const thread = await seedStream("private", [alice], { rootStreamId: product })
    const source = await seedMessage(thread)

    const shared = await shareInto(product, pointerTo(thread, source.id))
    expect(await sharesOf(source.id)).toEqual([{ shareMessageId: shared.id, targetStreamId: product }])
  })

  test("sharing into a target whose readers can all read the source needs no confirmation", async () => {
    const wide = await seedStream("private", [alice, bob])
    const narrow = await seedStream("private", [alice])
    const source = await seedMessage(wide)

    const shared = await shareInto(narrow, pointerTo(wide, source.id))
    expect(await sharesOf(source.id)).toEqual([{ shareMessageId: shared.id, targetStreamId: narrow }])
  })

  test("sharing a public message into a private channel that holds a guest asks", async () => {
    const open = await seedStream("public", [alice])
    const guestRoom = await seedStream("private", [alice, guest])
    const source = await seedMessage(open)

    await expectConfirmationRequired(shareInto(guestRoom, pointerTo(open, source.id)))
  })

  test("editing in an exposing quote asks", async () => {
    const leadership = await seedStream("private", [alice])
    const product = await seedStream("private", [alice, bob])
    const source = await seedMessage(leadership)
    const plain = await seedMessage(product)

    await expectConfirmationRequired(editTo(product, plain.id, paragraphOf("edited"), quoteOf(leadership, source.id)))
    expect(await sharesOf(source.id)).toEqual([])
  })

  test("editing a confirmed share that keeps its quote needs no new confirmation", async () => {
    const leadership = await seedStream("private", [alice])
    const product = await seedStream("private", [alice, bob])
    const source = await seedMessage(leadership)
    const confirmed = await shareInto(product, quoteOf(leadership, source.id), { confirmedPrivacyWarning: true })

    await editTo(product, confirmed.id, paragraphOf("edited"), quoteOf(leadership, source.id))
    expect(await sharesOf(source.id)).toEqual([{ shareMessageId: confirmed.id, targetStreamId: product }])
  })

  test("editing a confirmed share to add a second exposing quote asks", async () => {
    const leadership = await seedStream("private", [alice])
    const board = await seedStream("private", [alice])
    const product = await seedStream("private", [alice, bob])
    const kept = await seedMessage(leadership)
    const added = await seedMessage(board)
    const confirmed = await shareInto(product, quoteOf(leadership, kept.id), { confirmedPrivacyWarning: true })

    await expectConfirmationRequired(
      editTo(product, confirmed.id, quoteOf(leadership, kept.id), quoteOf(board, added.id))
    )
    expect(await sharesOf(added.id)).toEqual([])
  })

  test("sharing into a guest-public channel asks when the source is private", async () => {
    const leadership = await seedStream("private", [alice])
    const lobby = await seedStream("guest_public", [alice])
    const source = await seedMessage(leadership)

    await expectConfirmationRequired(shareInto(lobby, pointerTo(leadership, source.id)))
  })

  test("countReadersWithoutAccess counts per source, resolving a thread target through its root", async () => {
    const leadership = await seedStream("private", [alice])
    const wide = await seedStream("private", [alice, bob])
    const product = await seedStream("private", [alice, bob])
    const thread = await seedStream("private", [alice], { rootStreamId: product })

    expect(await countReadersWithoutAccess(pool, ws, thread, [leadership, wide])).toEqual(new Map([[leadership, 1]]))
    expect(await countReadersWithoutAccess(pool, ws, thread, [])).toEqual(new Map())
  })
})
