/**
 * Docs on the public API through the real handlers: a user key acts as its
 * owner and a bot key as the bot, each reaching exactly the docs its principal
 * can read, writing under the host's write rules, and seeing the service's
 * refusals as HTTP errors.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes, DocErrorCodes, StreamErrorCodes, StreamTypes, Visibilities } from "@threahq/types"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { DocAgentService, DocRepository, DocService } from "../../src/features/docs"
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
})
