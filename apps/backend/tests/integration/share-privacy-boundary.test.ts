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
import {
  StreamRepository,
  StreamMemberRepository,
  StreamService,
  findReadersWithoutAccess,
} from "../../src/features/streams"
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
    thread?: { rootStreamId: string },
    workspace = ws
  ): Promise<string> {
    const id = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id,
        workspaceId: workspace,
        type: thread ? "thread" : "channel",
        visibility,
        ...(thread ? { parentStreamId: thread.rootStreamId, rootStreamId: thread.rootStreamId } : {}),
        slug: `s-${id.slice(-8)}`,
        createdBy: alice,
      })
      for (const member of members) {
        await StreamMemberRepository.insert(client, workspace, id, member)
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

  test("findReadersWithoutAccess counts per source for a stream or user scope, sampling only when asked", async () => {
    const leadership = await seedStream("private", [alice])
    const wide = await seedStream("private", [alice, bob])
    const product = await seedStream("private", [alice, bob])
    const thread = await seedStream("private", [alice], { rootStreamId: product })
    const sample = { size: 3, viewerId: alice }

    expect({
      thread: await findReadersWithoutAccess(pool, ws, { streamId: thread }, [leadership, wide], sample),
      users: await findReadersWithoutAccess(pool, ws, { userIds: [bob, alice] }, [leadership, wide], sample),
      noSample: await findReadersWithoutAccess(pool, ws, { streamId: thread }, [leadership]),
      empty: await findReadersWithoutAccess(pool, ws, { streamId: thread }, [], sample),
    }).toEqual({
      thread: new Map([[leadership, { count: 1, sampleUserIds: [bob] }]]),
      users: new Map([[leadership, { count: 1, sampleUserIds: [bob] }]]),
      noSample: new Map([[leadership, { count: 1, sampleUserIds: [] }]]),
      empty: new Map(),
    })
  })

  describe("StreamService.listReferenceAudiences", () => {
    const streamService = () => new StreamService(pool)

    test("answers only readable refs in request order, per target kind, with a name-ordered sample capped at 3", async () => {
      const tag = streamId().slice(-6).toLowerCase()
      const reader = await withTransaction(pool, async (client) => {
        const ids: Record<string, string> = {}
        for (const letter of ["d", "b", "a", "c"]) {
          ids[letter] = (await addTestMember(client, ws, `wos_${tag}_reader-${letter}`)).id
        }
        return ids
      })
      const leadership = await seedStream("private", [alice])
      const hidden = await seedStream("private", [bob])
      const product = await seedStream("private", [alice, ...Object.values(reader)])
      const thread = await seedStream("private", [alice], { rootStreamId: product })

      const ask = (target: { streamId: string } | { dmUserId: string }) =>
        streamService().listReferenceAudiences({
          workspaceId: ws,
          userId: alice,
          target,
          streamIds: [product, leadership, leadership, hidden],
        })

      expect({
        thread: await ask({ streamId: thread }),
        dmToReader: await ask({ dmUserId: reader.c }),
        dmToBob: await ask({ dmUserId: bob }),
      }).toEqual({
        thread: [{ streamId: leadership, count: 4, sampleUserIds: [reader.a, reader.b, reader.c] }],
        dmToReader: [{ streamId: leadership, count: 1, sampleUserIds: [reader.c] }],
        dmToBob: [
          { streamId: product, count: 1, sampleUserIds: [bob] },
          { streamId: leadership, count: 1, sampleUserIds: [bob] },
        ],
      })
    })

    test("a guest's sample names only people the guest can see, while the count covers every reader", async () => {
      const guestWs = workspaceId()
      const tag = guestWs.slice(-6).toLowerCase()
      const people = await withTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: guestWs,
          name: "Share Privacy Guest",
          slug: `share-privacy-guest-${guestWs}`,
          createdBy: userId(),
        })
        return {
          guest: (await addTestMember(client, guestWs, `wos_${tag}_guest`, "guest")).id,
          seen: (await addTestMember(client, guestWs, `wos_${tag}_seen`)).id,
          unseen: (await addTestMember(client, guestWs, `wos_${tag}_unseen`)).id,
          sourceMember: (await addTestMember(client, guestWs, `wos_${tag}_source`)).id,
        }
      })
      const lobby = await seedStream("guest_public", [people.guest, people.seen], undefined, guestWs)
      const source = await seedStream("private", [people.guest, people.sourceMember], undefined, guestWs)

      expect(
        await streamService().listReferenceAudiences({
          workspaceId: guestWs,
          userId: people.guest,
          target: { streamId: lobby },
          streamIds: [source],
        })
      ).toEqual([{ streamId: source, count: 2, sampleUserIds: [people.seen] }])
    })

    test("an unreadable target, a self DM, or an unknown DM user is refused", async () => {
      const hidden = await seedStream("private", [bob])
      const leadership = await seedStream("private", [alice])
      const ask = (target: { streamId: string } | { dmUserId: string }) =>
        streamService()
          .listReferenceAudiences({ workspaceId: ws, userId: alice, target, streamIds: [leadership] })
          .catch((err) => err.code)

      expect({
        stream: await ask({ streamId: hidden }),
        self: await ask({ dmUserId: alice }),
        unknown: await ask({ dmUserId: userId() }),
      }).toEqual({ stream: "STREAM_NOT_FOUND", self: "DM_SELF_NOT_ALLOWED", unknown: "MEMBER_NOT_FOUND" })
    })
  })
})
