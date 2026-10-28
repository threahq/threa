/**
 * Docs on the public API through the real handlers: a user key acts as its
 * owner and a bot key as the bot, each reaching exactly the docs its principal
 * can read, writing under the host's write rules, and seeing the service's
 * refusals as HTTP errors.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes, DocErrorCodes, StreamErrorCodes, StreamTypes, Visibilities, sentViaApiKey } from "@threahq/types"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { DocAgentService, DocRepository, DocService } from "../../src/features/docs"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { BotRepository, createDocPublicApiHandlers } from "../../src/features/public-api"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { botChannelAccessId, botId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let handlers: ReturnType<typeof createDocPublicApiHandlers>
let ws: string
let owner: string
let outsider: string
let privateChannelId: string
let publicChannelId: string
let threadId: string
let grantedBotId: string
let strangerBotId: string

type Doc = { id: string; hostStreamId: string; title: string | null; seq: number; createdAt: string; markdown: string }

function recorder() {
  const payloads: unknown[] = []
  let statusCode = 200
  const res = { locals: {} } as unknown as Response
  res.status = ((code: number) => {
    statusCode = code
    return res
  }) as Response["status"]
  res.json = ((payload: unknown) => {
    payloads.push(payload)
    return res
  }) as Response["json"]
  return { res, last: <T>() => ({ status: statusCode, ...(payloads[payloads.length - 1] as { data: T }) }) }
}

const userReq = (asUser: string, extra: Record<string, unknown>) =>
  ({ workspaceId: ws, userApiKey: { id: "key_1" }, user: { id: asUser }, ...extra }) as unknown as Request
const botReq = (asBot: string, extra: Record<string, unknown>) =>
  ({ workspaceId: ws, botApiKey: { botId: asBot }, ...extra }) as unknown as Request

async function createDoc(req: Request) {
  const rec = recorder()
  await handlers.createDoc(req, rec.res)
  return rec.last<Doc>()
}

async function readDoc(req: Request) {
  const rec = recorder()
  await handlers.getDoc(req, rec.res)
  return rec.last<Doc>()
}

async function listDocs(req: Request) {
  const rec = recorder()
  await handlers.listDocs(req, rec.res)
  return rec.last<Omit<Doc, "markdown">[]>()
}

async function editDoc(req: Request) {
  const rec = recorder()
  await handlers.editDoc(req, rec.res)
  return rec.last<{ id: string; title: string | null; seq: number; touchedBlockIds: string[]; markdown: string }>()
}

type Comment = { threadId: string; message: Record<string, unknown> }

async function comment(req: Request) {
  const rec = recorder()
  await handlers.commentOnDocSection(req, rec.res)
  return rec.last<Comment>()
}

const blockIds = (markdown: string) => [...markdown.matchAll(/<!-- (blk_\w+) -->/g)].map((m) => m[1])

const unmarked = (markdown: string) => markdown.replace(/<!-- blk_\w+ -->\n/g, "")

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("public-api-docs")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  const botChannelService = new BotChannelService({ pool })
  handlers = createDocPublicApiHandlers({
    docAgentService: new DocAgentService({
      pool,
      docService: new DocService({ pool }),
      streamService,
      botChannelService,
    }),
    pool,
    eventService: new EventService(pool),
  })
  ws = workspaceId()
  privateChannelId = streamId()
  publicChannelId = streamId()
  threadId = streamId()
  grantedBotId = botId()
  strangerBotId = botId()
  await withTransaction(pool, async (client) => {
    await WorkspaceRepository.insert(client, { id: ws, name: "Docs API", slug: `docs-api-${ws}`, createdBy: userId() })
    owner = (await addTestMember(client, ws, userId())).id
    outsider = (await addTestMember(client, ws, userId())).id
    await StreamRepository.insert(client, {
      id: privateChannelId,
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      visibility: Visibilities.PRIVATE,
      slug: "private-docs",
      createdBy: owner,
    })
    await StreamRepository.insert(client, {
      id: publicChannelId,
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      visibility: Visibilities.PUBLIC,
      slug: "public-docs",
      createdBy: owner,
    })
    await StreamRepository.insert(client, {
      id: threadId,
      workspaceId: ws,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PUBLIC,
      parentStreamId: publicChannelId,
      parentAnchorId: messageId(),
      rootStreamId: publicChannelId,
      createdBy: owner,
    })
    await StreamMemberRepository.insert(client, ws, privateChannelId, owner)
    await StreamMemberRepository.insert(client, ws, publicChannelId, owner)
    for (const [id, slug] of [
      [grantedBotId, "granted"],
      [strangerBotId, "stranger"],
    ] as const) {
      await BotRepository.create(client, { id, workspaceId: ws, type: "shared", ownerUserId: null, slug, name: slug })
    }
    await BotChannelAccessRepository.grantAccess(client, {
      id: botChannelAccessId(),
      workspaceId: ws,
      botId: grantedBotId,
      streamId: privateChannelId,
      grantedBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

describe("public API docs", () => {
  test("should create, list, read and edit a doc as the key's owner", async () => {
    const created = await createDoc(
      userReq(owner, {
        body: {
          streamId: privateChannelId,
          title: " Rotation tracker ",
          markdown: "## Keys\n\n- AWS key is live",
          reason: "Start the tracker",
        },
      })
    )
    const listed = await listDocs(userReq(owner, { query: { streamId: privateChannelId } }))
    const read = await readDoc(userReq(owner, { params: { docId: created.data.id } }))
    const edited = await editDoc(
      userReq(owner, {
        params: { docId: created.data.id },
        body: { reason: "AWS key revoked", edits: [{ old: "is live", new: "is revoked" }] },
      })
    )
    const updates = await DocRepository.listUpdatesAfter(pool, ws, created.data.id, 0)
    const edits = await StreamEventRepository.list(pool, ws, created.data.id, { types: ["doc:edited"] })
    const markers = [...read.data.markdown.matchAll(/<!-- (blk_\w+) -->/g)].map((m) => m[1])

    expect({
      created: { ...created, data: { ...created.data, markdown: unmarked(created.data.markdown) } },
      listed,
      read: { status: read.status, markdown: unmarked(read.data.markdown) },
      edited: { ...edited, data: { ...edited.data, markdown: unmarked(edited.data.markdown) } },
      actors: updates.map(({ seq, actorId, actorType }) => ({ seq, actorId, actorType })),
      reasons: edits.map((event) => (event.payload as { reason?: string }).reason),
    }).toEqual({
      created: {
        status: 201,
        data: {
          id: created.data.id,
          hostStreamId: privateChannelId,
          title: "Rotation tracker",
          seq: 1,
          createdAt: expect.any(String),
          markdown: "## Keys\n\n- AWS key is live",
        },
      },
      listed: {
        status: 200,
        data: [
          {
            id: created.data.id,
            hostStreamId: privateChannelId,
            title: "Rotation tracker",
            seq: 1,
            createdAt: created.data.createdAt,
          },
        ],
      },
      read: { status: 200, markdown: "## Keys\n\n- AWS key is live" },
      edited: {
        status: 200,
        data: {
          id: created.data.id,
          title: "Rotation tracker",
          seq: 2,
          touchedBlockIds: [markers[1]],
          markdown: "- AWS key is revoked",
        },
      },
      actors: [
        { seq: 1, actorId: owner, actorType: AuthorTypes.USER },
        { seq: 2, actorId: owner, actorType: AuthorTypes.USER },
      ],
      reasons: ["Start the tracker", "AWS key revoked"],
    })
  })

  test("should apply an edit whose old carries the trailing newline a copy from the read output picks up", async () => {
    const created = await createDoc(
      userReq(owner, {
        body: { streamId: privateChannelId, markdown: "Deadline is Friday\n\nOwner is Sam", reason: "Seed" },
      })
    )
    const markers = [...created.data.markdown.matchAll(/<!-- (blk_\w+) -->/g)].map((m) => m[1])

    const edited = await editDoc(
      userReq(owner, {
        params: { docId: created.data.id },
        body: { reason: "Moved the deadline", edits: [{ old: "Deadline is Friday\n", new: "Deadline is Monday\n" }] },
      })
    )

    expect({ ...edited, data: { ...edited.data, markdown: unmarked(edited.data.markdown) } }).toEqual({
      status: 200,
      data: {
        id: created.data.id,
        title: null,
        seq: 2,
        touchedBlockIds: [markers[0]],
        markdown: "Deadline is Monday",
      },
    })
  })

  test("should refuse an edit that misses or matches twice with the text to retry against", async () => {
    const created = await createDoc(
      userReq(owner, {
        body: { streamId: publicChannelId, markdown: "GCP key is live\n\nGCP key is live", reason: "Seed" },
      })
    )
    const edit = (edits: { blockId?: string; old: string; new: string }[]) =>
      editDoc(userReq(owner, { params: { docId: created.data.id }, body: { reason: "Edit", edits } }))

    await expect(edit([{ old: "Azure", new: "Entra" }])).rejects.toMatchObject({
      status: 409,
      code: DocErrorCodes.EDIT_TEXT_NOT_FOUND,
      details: { editIndex: 0, scope: { markdown: expect.stringContaining("GCP key is live") } },
    })
    await expect(edit([{ old: "GCP key", new: "GCP service key" }])).rejects.toMatchObject({
      status: 409,
      code: DocErrorCodes.EDIT_TEXT_AMBIGUOUS,
    })
    await expect(edit([{ blockId: "blk_missing", old: "GCP", new: "G" }])).rejects.toMatchObject({
      status: 409,
      code: DocErrorCodes.SECTION_NOT_FOUND,
    })
    const [firstBlock] = [...created.data.markdown.matchAll(/<!-- (blk_\w+) -->/g)].map((m) => m[1])
    const unchanged = await edit([{ blockId: firstBlock, old: "GCP key is live", new: "GCP key is live" }])
    expect(unchanged.data).toMatchObject({ seq: 1, touchedBlockIds: [], markdown: "" })
  })

  test("should hide a private host's docs from an outsider and refuse a public host's non-member writes", async () => {
    const hidden = await createDoc(userReq(owner, { body: { streamId: privateChannelId, title: "Hidden" } }))
    const open = await createDoc(userReq(owner, { body: { streamId: publicChannelId, title: "Open" } }))
    const edit = { reason: "Edit", edits: [{ old: "x", new: "y" }] }

    await expect(listDocs(userReq(outsider, { query: { streamId: privateChannelId } }))).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })
    await expect(readDoc(userReq(outsider, { params: { docId: hidden.data.id } }))).rejects.toMatchObject({
      status: 404,
    })
    await expect(editDoc(userReq(outsider, { params: { docId: hidden.data.id }, body: edit }))).rejects.toMatchObject({
      status: 404,
    })
    expect((await readDoc(userReq(outsider, { params: { docId: open.data.id } }))).data.title).toBe("Open")
    await expect(editDoc(userReq(outsider, { params: { docId: open.data.id }, body: edit }))).rejects.toMatchObject({
      status: 403,
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: "not_a_member" },
    })
    await expect(createDoc(userReq(outsider, { body: { streamId: publicChannelId } }))).rejects.toMatchObject({
      status: 403,
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: "not_a_member" },
    })
  })

  test("should let a bot read and edit through its grant on the private host and hide it from a stranger bot", async () => {
    const created = await createDoc(
      userReq(owner, { body: { streamId: privateChannelId, markdown: "Rotate by Friday", reason: "Seed" } })
    )
    const listed = await listDocs(botReq(grantedBotId, { query: { streamId: privateChannelId } }))
    const read = await readDoc(botReq(grantedBotId, { params: { docId: created.data.id } }))
    const edited = await editDoc(
      botReq(grantedBotId, {
        params: { docId: created.data.id },
        body: { reason: "Moved the deadline", edits: [{ old: "Friday", new: "Monday" }] },
      })
    )
    const updates = await DocRepository.listUpdatesAfter(pool, ws, created.data.id, 1)

    expect({
      listedIds: listed.data.map((doc) => doc.id),
      read: unmarked(read.data.markdown),
      edited: { seq: edited.data.seq, markdown: unmarked(edited.data.markdown) },
      actors: updates.map(({ actorId, actorType }) => ({ actorId, actorType })),
    }).toEqual({
      listedIds: expect.arrayContaining([created.data.id]),
      read: "Rotate by Friday",
      edited: { seq: 2, markdown: "Rotate by Monday" },
      actors: [{ actorId: grantedBotId, actorType: AuthorTypes.BOT }],
    })
    await expect(listDocs(botReq(strangerBotId, { query: { streamId: privateChannelId } }))).rejects.toMatchObject({
      status: 404,
    })
    await expect(readDoc(botReq(strangerBotId, { params: { docId: created.data.id } }))).rejects.toMatchObject({
      status: 404,
    })
    const privateThreadId = streamId()
    await StreamRepository.insert(pool, {
      id: privateThreadId,
      workspaceId: ws,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId: privateChannelId,
      parentAnchorId: messageId(),
      rootStreamId: privateChannelId,
      createdBy: owner,
    })
    await expect(createDoc(botReq(strangerBotId, { body: { streamId: privateThreadId } }))).rejects.toMatchObject({
      status: 404,
    })
  })

  test("should reject a body without a reason and a host that cannot hold docs", async () => {
    await expect(
      createDoc(userReq(owner, { body: { streamId: publicChannelId, markdown: "x" } }))
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    await expect(createDoc(userReq(owner, { body: { streamId: threadId } }))).rejects.toMatchObject({
      status: 400,
      code: DocErrorCodes.HOST_TYPE_INVALID,
    })
  })

  test("should read an archived doc as missing and refuse to edit it", async () => {
    const created = await createDoc(
      userReq(owner, { body: { streamId: publicChannelId, markdown: "Old", reason: "Seed" } })
    )
    await streamService.archiveStream(created.data.id, ws, owner)

    await expect(readDoc(userReq(owner, { params: { docId: created.data.id } }))).rejects.toMatchObject({ status: 404 })
    await expect(
      editDoc(
        userReq(owner, {
          params: { docId: created.data.id },
          body: { reason: "Edit", edits: [{ old: "Old", new: "New" }] },
        })
      )
    ).rejects.toMatchObject({ status: 403, code: StreamErrorCodes.READ_ONLY, details: { reason: "archived" } })
    expect(
      (await listDocs(userReq(owner, { query: { streamId: publicChannelId } }))).data.map((doc) => doc.id)
    ).not.toContain(created.data.id)
  })

  describe("commenting on a block", () => {
    const ownerReq = (extra: Record<string, unknown>) =>
      userReq(owner, { user: { id: owner, name: "Owner" }, ...extra })

    async function seededDoc() {
      const created = await createDoc(
        userReq(owner, { body: { streamId: publicChannelId, markdown: "Rotate keys\n\nAudit logs", reason: "Seed" } })
      )
      return { docId: created.data.id, blocks: blockIds(created.data.markdown) }
    }

    test("should create the block's thread and post the comment when a block has no thread", async () => {
      const { docId, blocks } = await seededDoc()
      const posted = await comment(
        ownerReq({
          params: { docId, blockId: blocks[1] },
          body: { content: "Who owns **this**?", clientMessageId: "cm-create", metadata: { source: "cli" } },
        })
      )
      const thread = await StreamRepository.findById(pool, ws, posted.data.threadId)

      expect({
        posted,
        thread: thread && {
          type: thread.type,
          parentStreamId: thread.parentStreamId,
          parentAnchorId: thread.parentAnchorId,
          rootStreamId: thread.rootStreamId,
          createdBy: thread.createdBy,
        },
      }).toEqual({
        posted: {
          status: 201,
          data: {
            threadId: expect.stringMatching(/^stream_/),
            message: {
              id: expect.stringMatching(/^msg_/),
              streamId: posted.data.threadId,
              sequence: expect.any(String),
              authorId: owner,
              authorType: AuthorTypes.USER,
              authorDisplayName: "Owner",
              content: "Who owns **this**?",
              replyCount: 0,
              clientMessageId: "cm-create",
              sentVia: sentViaApiKey("key_1"),
              metadata: { source: "cli" },
              revision: 1,
              createdAt: expect.any(String),
            },
          },
        },
        thread: {
          type: StreamTypes.THREAD,
          parentStreamId: docId,
          parentAnchorId: blocks[1],
          rootStreamId: publicChannelId,
          createdBy: owner,
        },
      })
    })

    test("should reuse the existing thread when the block already has one", async () => {
      const { docId, blocks } = await seededDoc()
      const existing = await streamService.createThread({
        workspaceId: ws,
        parentStreamId: docId,
        parentAnchorId: blocks[0],
        createdBy: owner,
        principal: { kind: "user", userId: owner },
      })

      const posted = await comment(ownerReq({ params: { docId, blockId: blocks[0] }, body: { content: "Done" } }))

      expect({ threadId: posted.data.threadId, streamId: posted.data.message.streamId }).toEqual({
        threadId: existing.id,
        streamId: existing.id,
      })
    })

    test("should return the same message when retried with the same clientMessageId", async () => {
      const { docId, blocks } = await seededDoc()
      const send = () =>
        comment(
          ownerReq({ params: { docId, blockId: blocks[0] }, body: { content: "Ack", clientMessageId: "cm-retry" } })
        )

      const first = await send()
      const retried = await send()
      const messages = await MessageRepository.list(pool, ws, first.data.threadId)

      expect({ retried, messageIds: messages.map((m) => m.id) }).toEqual({
        retried: first,
        messageIds: [first.data.message.id as string],
      })
    })

    test("should 404 when the block is not in the doc", async () => {
      const { docId } = await seededDoc()
      const other = await seededDoc()

      for (const blockId of ["blk_missing", other.blocks[0]]) {
        await expect(comment(ownerReq({ params: { docId, blockId }, body: { content: "Hi" } }))).rejects.toMatchObject({
          status: 404,
          code: DocErrorCodes.SECTION_NOT_FOUND,
        })
      }
    })

    test("should 404 when the key cannot read the doc", async () => {
      const hidden = await createDoc(
        userReq(owner, { body: { streamId: privateChannelId, markdown: "Secret", reason: "Seed" } })
      )
      const [blockId] = blockIds(hidden.data.markdown)

      await expect(
        comment(userReq(outsider, { params: { docId: hidden.data.id, blockId }, body: { content: "Hi" } }))
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
    })

    test("should create one thread when two first comments on a block race", async () => {
      const { docId, blocks } = await seededDoc()
      const send = (clientMessageId: string) =>
        comment(
          ownerReq({ params: { docId, blockId: blocks[0] }, body: { content: clientMessageId, clientMessageId } })
        )

      const [a, b] = await Promise.all([send("cm-race-a"), send("cm-race-b")])
      const messages = await MessageRepository.list(pool, ws, a.data.threadId)

      expect({ threadIds: [a.data.threadId, b.data.threadId], messageIds: new Set(messages.map((m) => m.id)) }).toEqual(
        {
          threadIds: [a.data.threadId, a.data.threadId],
          messageIds: new Set([a.data.message.id as string, b.data.message.id as string]),
        }
      )
    })

    test("should refuse with STREAM_READ_ONLY when a non-member comments on a doc in a public channel", async () => {
      const { docId, blocks } = await seededDoc()

      await expect(
        comment(userReq(outsider, { params: { docId, blockId: blocks[0] }, body: { content: "Hi" } }))
      ).rejects.toMatchObject({ status: 403, code: StreamErrorCodes.READ_ONLY, details: { reason: "not_a_member" } })
      expect(await StreamRepository.findByAnchor(pool, ws, docId, blocks[0])).toBeNull()
    })

    test("should refuse with STREAM_READ_ONLY when the doc is archived", async () => {
      const { docId, blocks } = await seededDoc()
      await streamService.archiveStream(docId, ws, owner)

      await expect(
        comment(ownerReq({ params: { docId, blockId: blocks[0] }, body: { content: "Hi" } }))
      ).rejects.toMatchObject({ status: 403, code: StreamErrorCodes.READ_ONLY, details: { reason: "archived" } })
      expect(await StreamRepository.findByAnchor(pool, ws, docId, blocks[0])).toBeNull()
    })

    test("should post as the bot when a bot key with a grant on the host comments", async () => {
      const created = await createDoc(
        userReq(owner, { body: { streamId: privateChannelId, markdown: "Rotate keys", reason: "Seed" } })
      )
      const [blockId] = blockIds(created.data.markdown)

      const posted = await comment(
        botReq(grantedBotId, { params: { docId: created.data.id, blockId }, body: { content: "On it" } })
      )
      const thread = await StreamRepository.findByAnchor(pool, ws, created.data.id, blockId)

      expect({
        status: posted.status,
        author: { id: posted.data.message.authorId, type: posted.data.message.authorType },
        thread: thread && { id: thread.id, createdBy: thread.createdBy, rootStreamId: thread.rootStreamId },
      }).toEqual({
        status: 201,
        author: { id: grantedBotId, type: AuthorTypes.BOT },
        thread: { id: posted.data.threadId, createdBy: grantedBotId, rootStreamId: privateChannelId },
      })
    })

    test("should reject a block id that is not a blk_ id", async () => {
      const { docId } = await seededDoc()

      await expect(
        comment(ownerReq({ params: { docId, blockId: "stream_abc" }, body: { content: "Hi" } }))
      ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    })
  })
})
