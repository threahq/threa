/**
 * Doc share grants against the real schema (INV-68): a message carrying a doc
 * chip lets its stream's readers read the doc, read-only, for as long as the
 * message carries the chip. Exercised through the real message create, edit
 * and delete paths.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import * as Y from "yjs"
import { ShareErrorCodes, type JSONContent, type Stream } from "@threahq/types"
import {
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import {
  StreamBriefService,
  StreamService,
  checkStreamAccess,
  createStreamBriefHandlers,
  listAccessibleStreamIds,
} from "../../src/features/streams"
import { createStreamContextService } from "../../src/features/stream-context"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let eventService: EventService
let wsId: string
let owner: string
let peer: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-sharing")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  eventService = new EventService(pool)
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    peer = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs Sharing Test Workspace",
      slug: `docs-sharing-ws-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createChannel(visibility: "public" | "private", memberIds: string[] = []): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `docs-sharing-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
}

async function createPrivateDoc(): Promise<Stream> {
  const host = await createChannel("private")
  return streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: host.id, createdBy: owner })
}

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const text = (value: string): JSONContent => ({ type: "text", text: value })
const chip = (docId: string): JSONContent => ({ type: "docEmbed", attrs: { docId, title: "Plan" } })
const body = (...content: JSONContent[]): JSONContent => ({ type: "doc", content: [paragraph(...content)] })

function appendBlock(ydoc: Y.Doc, block: JSONContent): string {
  const json = ydocToContentJson(ydoc)
  return encodeUpdateBase64(writeContentJson(ydoc, { ...json, content: [...(json.content ?? []), block] }))
}

async function openDoc(docId: string, userIdForDoc: string): Promise<Y.Doc> {
  const { state } = await docService.get({ workspaceId: wsId, userId: userIdForDoc, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  return ydoc
}

function post(
  streamIdToPost: string,
  contentJson: JSONContent,
  extras: {
    authorId?: string
    authorType?: "user" | "persona"
    accessibleStreamIds?: string[]
    confirmedPrivacyWarning?: boolean
    consentedShareSourceIds?: ReadonlySet<string>
  } = {}
) {
  return eventService.createMessage({
    workspaceId: wsId,
    streamId: streamIdToPost,
    authorId: extras.authorId ?? owner,
    authorType: extras.authorType ?? "user",
    accessibleStreamIds: extras.accessibleStreamIds,
    contentJson,
    contentMarkdown: "shared",
    confirmedPrivacyWarning: extras.confirmedPrivacyWarning,
    consentedShareSourceIds: extras.consentedShareSourceIds,
  })
}

async function grantCount(docId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM shared_docs WHERE workspace_id = $1 AND doc_id = $2",
    [wsId, docId]
  )
  return result.rows[0]!.count
}

async function briefStatus(docId: string, viewer: string): Promise<number> {
  const handlers = createStreamBriefHandlers({ pool, streamBriefService: new StreamBriefService({ pool }) })
  const res = { json: () => res } as unknown as Response
  try {
    await handlers.get(
      { user: { id: viewer }, workspaceId: wsId, params: { streamId: docId } } as unknown as Request,
      res
    )
    return 200
  } catch (error) {
    return (error as { status: number }).status
  }
}

async function streamContextStatus(docId: string, viewer: string): Promise<number> {
  try {
    await createStreamContextService({ pool }).list({
      workspaceId: wsId,
      userId: viewer,
      streamId: docId,
      scope: "tree",
      limit: 10,
    })
    return 200
  } catch (error) {
    return (error as { status: number }).status
  }
}

function edit(streamIdToEdit: string, messageIdToEdit: string, contentJson: JSONContent) {
  return eventService.editMessageInternal({
    workspaceId: wsId,
    messageId: messageIdToEdit,
    streamId: streamIdToEdit,
    contentJson,
    contentMarkdown: "edited",
    actorId: owner,
  })
}

async function outsiderReads(docId: string) {
  return {
    checkStreamAccess: (await checkStreamAccess(pool, docId, wsId, outsider))?.id ?? null,
    listAccessible: [...(await listAccessibleStreamIds(pool, wsId, outsider, [docId]))],
  }
}

const reads = (docId: string) => ({ checkStreamAccess: docId, listAccessible: [docId] })
const blocked = { checkStreamAccess: null, listAccessible: [] }

describe("doc share grants", () => {
  test("should let an outsider read a doc when a message carrying its chip is posted in a channel they read", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")

    expect(await outsiderReads(doc.id)).toEqual(blocked)
    await expect(docService.get({ workspaceId: wsId, userId: outsider, docId: doc.id })).rejects.toMatchObject({
      status: 404,
    })

    await post(open.id, body(text("see "), chip(doc.id)), { confirmedPrivacyWarning: true })

    expect(await outsiderReads(doc.id)).toEqual(reads(doc.id))
    const loaded = await docService.get({ workspaceId: wsId, userId: outsider, docId: doc.id })
    expect(typeof loaded.state).toBe("string")
  })

  test("should refuse an outsider's doc update when their read comes from a share grant", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })

    const update = appendBlock(await openDoc(doc.id, outsider), {
      type: "paragraph",
      attrs: { blockId: blockId() },
      content: [text("x")],
    })

    await expect(
      docService.postUpdate({ workspaceId: wsId, userId: outsider, docId: doc.id, update })
    ).rejects.toMatchObject({ status: 404 })
  })

  test("should drop the grant when the carrying message is deleted", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    const message = await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    expect(await outsiderReads(doc.id)).toEqual(reads(doc.id))

    await eventService.deleteMessageInternal({
      workspaceId: wsId,
      messageId: message.id,
      streamId: open.id,
      actorId: owner,
    })

    expect(await outsiderReads(doc.id)).toEqual(blocked)
  })

  test("should drop the grant when an edit removes the chip", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    const message = await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    const beforeEdit = await outsiderReads(doc.id)

    await edit(open.id, message.id, body(text("never mind")))

    expect({ beforeEdit, afterEdit: await outsiderReads(doc.id) }).toEqual({
      beforeEdit: reads(doc.id),
      afterEdit: blocked,
    })
  })

  test("should leave an outsider blocked when the chip is posted in a private channel they cannot read", async () => {
    const doc = await createPrivateDoc()
    const closed = await createChannel("private", [peer])

    await post(closed.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })

    expect({ grants: await grantCount(doc.id), outsider: await outsiderReads(doc.id) }).toEqual({
      grants: 1,
      outsider: blocked,
    })
  })

  test("should 404 the host-scoped stream context and brief when a grant-only reader asks for the doc's", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })

    expect({
      ownerContext: await streamContextStatus(doc.id, owner),
      ownerBrief: await briefStatus(doc.id, owner),
      outsiderContext: await streamContextStatus(doc.id, outsider),
      outsiderBrief: await briefStatus(doc.id, outsider),
    }).toEqual({ ownerContext: 200, ownerBrief: 200, outsiderContext: 404, outsiderBrief: 404 })
  })

  test("should refuse with SOURCE_FORBIDDEN and grant nothing when a grant-only reader re-shares the doc", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    const outsiderRoom = await createChannel("private", [outsider])

    await expect(
      post(outsiderRoom.id, body(chip(doc.id)), { authorId: outsider, confirmedPrivacyWarning: true })
    ).rejects.toMatchObject({ status: 403, code: ShareErrorCodes.SOURCE_FORBIDDEN })
    expect(await grantCount(doc.id)).toBe(1)
  })

  test("should refuse with SOURCE_FORBIDDEN and grant nothing when an agent's scope reaches the doc only through a grant", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    const outsiderRoom = await createChannel("private", [outsider])
    const scope = [...(await listAccessibleStreamIds(pool, wsId, outsider, [doc.id, open.id, outsiderRoom.id]))]

    await expect(
      post(outsiderRoom.id, body(chip(doc.id)), {
        authorId: "persona_ariadne",
        authorType: "persona",
        accessibleStreamIds: scope,
        confirmedPrivacyWarning: true,
      })
    ).rejects.toMatchObject({ status: 403, code: ShareErrorCodes.SOURCE_FORBIDDEN })
    expect({ scopeHasDoc: scope.includes(doc.id), grants: await grantCount(doc.id) }).toEqual({
      scopeHasDoc: true,
      grants: 1,
    })
  })

  test("should send without a grant for a chip that is not a doc when a scheduled fire carries it", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    const other = await createChannel("private")

    const message = await post(open.id, body(chip(other.id), chip(streamId()), chip(doc.id)), {
      consentedShareSourceIds: new Set([doc.id]),
    })

    expect({
      sent: typeof message.id,
      otherGrants: await grantCount(other.id),
      outsider: await outsiderReads(doc.id),
    }).toEqual({ sent: "string", otherGrants: 0, outsider: reads(doc.id) })
  })

  test("should grant readers of the channel when the carrying message is in a thread under it", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    const anchor = await post(open.id, body(text("anchor")))
    const thread = await streamService.createThreadInternal({
      workspaceId: wsId,
      parentStreamId: open.id,
      parentAnchorId: anchor.id,
      createdBy: owner,
    })

    await post(thread.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })

    expect(await outsiderReads(doc.id)).toEqual(reads(doc.id))
  })

  test("should refuse with SOURCE_FORBIDDEN when the sharer cannot read the doc", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public", [peer])

    await expect(
      post(open.id, body(chip(doc.id)), { authorId: peer, confirmedPrivacyWarning: true })
    ).rejects.toMatchObject({ status: 403, code: ShareErrorCodes.SOURCE_FORBIDDEN })
  })

  test("should refuse with SOURCE_STREAM_NOT_FOUND when the chip points at a stream that is not a doc", async () => {
    const open = await createChannel("public")
    const other = await createChannel("private")

    for (const docId of [other.id, streamId()]) {
      await expect(post(open.id, body(chip(docId)), { confirmedPrivacyWarning: true })).rejects.toMatchObject({
        status: 400,
        code: ShareErrorCodes.SOURCE_STREAM_NOT_FOUND,
      })
    }
  })

  test("should ask for privacy confirmation when the chip exposes the doc and not again on an edit that keeps it", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")

    await expect(post(open.id, body(chip(doc.id)))).rejects.toMatchObject({
      status: 409,
      code: ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED,
    })
    expect(await outsiderReads(doc.id)).toEqual(blocked)

    const message = await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    await edit(open.id, message.id, body(text("still here: "), chip(doc.id)))

    expect(await outsiderReads(doc.id)).toEqual(reads(doc.id))
  })

  test("should hide doc threads from a grantee in the thread list and the bootstrap when they cannot read the threads", async () => {
    const doc = await createPrivateDoc()
    const open = await createChannel("public")
    const anchor = blockId()
    const update = appendBlock(await openDoc(doc.id, owner), {
      ...paragraph(text("Ship it")),
      attrs: { blockId: anchor },
    })
    await docService.postUpdate({ workspaceId: wsId, userId: owner, docId: doc.id, update })
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: doc.id,
      parentAnchorId: anchor,
      createdBy: owner,
      principal: { kind: "user", userId: owner },
    })
    await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })

    const bootstrapThreads = async (viewer: string) => [
      ...(await streamService.getViewerThreads(wsId, doc, viewer)).threadDataMap.values(),
    ]

    expect({
      owner: await docService.listThreads({ workspaceId: wsId, userId: owner, docId: doc.id }),
      outsider: await docService.listThreads({ workspaceId: wsId, userId: outsider, docId: doc.id }),
      ownerBootstrap: await bootstrapThreads(owner),
      outsiderBootstrap: await bootstrapThreads(outsider),
    }).toEqual({
      owner: [{ blockId: anchor, threadId: thread.id, replyCount: 0 }],
      outsider: [],
      ownerBootstrap: [{ threadId: thread.id, replyCount: 0 }],
      outsiderBootstrap: [],
    })
  })
})
