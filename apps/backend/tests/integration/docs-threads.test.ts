/**
 * Section threads on doc blocks against the real schema (INV-68): a `blk_`
 * anchor validated against `doc_sections`, the thread gate that lets a doc's
 * members discuss what the doc refuses as messages, and the doc's thread list
 * and section reads.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import type { DocSection, JSONContent, Stream } from "@threahq/types"
import { DocService, decodeUpdateBase64, encodeUpdateBase64, writeContentJson } from "../../src/features/docs"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, eventId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, testMessageContent, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-threads")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs Threads Test Workspace",
      slug: `docs-threads-ws-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createChannel(visibility: "public" | "private"): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `doc-threads-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
  })
}

/** A doc under a fresh channel holding one paragraph, projected into `doc_sections`. */
async function seedDoc(visibility: "public" | "private" = "public") {
  const channel = await createChannel(visibility)
  const doc = await streamService.create({
    workspaceId: wsId,
    type: "doc",
    parentStreamId: channel.id,
    createdBy: owner,
  })
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const block = blockId()
  const paragraph: JSONContent = {
    type: "paragraph",
    attrs: { blockId: block },
    content: [{ type: "text", text: "Ship it" }],
  }
  const update = encodeUpdateBase64(writeContentJson(ydoc, { type: "doc", content: [paragraph] }))
  await docService.postUpdate({ workspaceId: wsId, userId: owner, docId: doc.id, update })
  return { channel, doc, block }
}

function threadOn(parentStreamId: string, parentAnchorId: string, actor = owner) {
  return streamService.createThread({
    workspaceId: wsId,
    parentStreamId,
    parentAnchorId,
    createdBy: actor,
    principal: { kind: "user", userId: actor },
  })
}

async function outboxPayloads(eventType: string, field: string, value: string) {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>$2 = $3 ORDER BY id`,
    [eventType, field, value]
  )
  return result.rows.map((row) => row.payload)
}

describe("doc section threads", () => {
  test("should create one thread per block under the doc's root when a member comments on a block", async () => {
    const { channel, doc, block } = await seedDoc()

    const thread = await threadOn(doc.id, block)
    const again = await threadOn(doc.id, block)

    const landmarks = await pool.query("SELECT id FROM stream_context_items WHERE ref_id = $1", [thread.id])
    expect({
      thread: {
        type: thread.type,
        parentStreamId: thread.parentStreamId,
        parentAnchorId: thread.parentAnchorId,
        rootStreamId: thread.rootStreamId,
        visibility: thread.visibility,
      },
      againId: again.id,
      creatorIsMember: await StreamMemberRepository.isMember(pool, wsId, thread.id, owner),
      created: (await outboxPayloads("stream:created", "streamId", thread.id)).length,
      landmarks: landmarks.rows,
    }).toEqual({
      thread: {
        type: "thread",
        parentStreamId: doc.id,
        parentAnchorId: block,
        rootStreamId: channel.id,
        visibility: "public",
      },
      againId: thread.id,
      creatorIsMember: true,
      created: 1,
      landmarks: [],
    })
  })

  test("should hide a private host's doc and refuse a public host's reader when a non-member comments", async () => {
    const hidden = await seedDoc("private")
    const open = await seedDoc("public")

    await expect(threadOn(hidden.doc.id, hidden.block, outsider)).rejects.toMatchObject({ status: 404 })
    await expect(threadOn(open.doc.id, open.block, outsider)).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "not_a_member" },
    })
    const threads = await pool.query("SELECT id FROM streams WHERE parent_stream_id = ANY($1)", [
      [hidden.doc.id, open.doc.id],
    ])
    expect(threads.rows).toEqual([])
  })

  test("should still refuse threads on an archived host's doc and on a system stream", async () => {
    const { channel, doc, block } = await seedDoc()
    await streamService.archiveStream(channel.id, wsId, owner)

    const system = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: wsId,
      type: "system",
      visibility: "private",
      createdBy: owner,
    })
    await StreamMemberRepository.insert(pool, wsId, system.id, owner)
    const card = await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsId,
      streamId: system.id,
      eventType: "delegation:created",
      payload: {},
      actorId: owner,
      actorType: "user",
    })

    await expect(threadOn(doc.id, block)).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "archived" },
    })
    await expect(threadOn(system.id, card.id)).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "system_stream" },
    })
    await streamService.archiveStream(system.id, wsId, owner)
    await expect(threadOn(system.id, card.id)).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "archived" },
    })
  })

  test("should refuse an unknown block and a message anchor on a doc, and a block anchor on a channel", async () => {
    const { channel, doc, block } = await seedDoc()

    await expect(threadOn(doc.id, blockId())).rejects.toMatchObject({ status: 404, code: "ANCHOR_NOT_FOUND" })
    await expect(threadOn(doc.id, messageId())).rejects.toMatchObject({ status: 400, code: "ANCHOR_INVALID" })
    await expect(threadOn(channel.id, block)).rejects.toMatchObject({ status: 400, code: "ANCHOR_INVALID" })
  })

  test("should route a block thread's reply count to the doc and list it when a reply is posted", async () => {
    const { doc, block } = await seedDoc()
    const thread = await threadOn(doc.id, block)

    await new EventService(pool).createMessageForPrincipalReturningConversation(
      { kind: "user", userId: owner },
      { workspaceId: wsId, streamId: thread.id, authorId: owner, authorType: "user", ...testMessageContent("Agreed") }
    )

    const [updated] = await outboxPayloads("thread:updated", "threadId", thread.id)
    expect({
      updated,
      threads: await docService.listThreads({ workspaceId: wsId, userId: outsider, docId: doc.id }),
    }).toEqual({
      updated: {
        workspaceId: wsId,
        streamId: doc.id,
        parentStreamId: doc.id,
        anchorId: block,
        threadId: thread.id,
        replyCount: 1,
        threadSummary: expect.objectContaining({ participants: [{ id: owner, type: "user" }] }),
      },
      threads: [{ blockId: block, threadId: thread.id, replyCount: 1 }],
    })
  })

  test("should return the projected section and 404 a missing block when a reader fetches a section", async () => {
    const { doc, block } = await seedDoc()

    const section = await docService.getSection({ workspaceId: wsId, userId: outsider, docId: doc.id, blockId: block })
    expect(section).toEqual({
      blockId: block,
      position: 0,
      kind: "paragraph",
      markdown: "Ship it",
      contentJson: { type: "paragraph", attrs: { blockId: block }, content: [{ type: "text", text: "Ship it" }] },
    } satisfies DocSection)
    await expect(
      docService.getSection({ workspaceId: wsId, userId: owner, docId: doc.id, blockId: blockId() })
    ).rejects.toMatchObject({ status: 404, code: "DOC_SECTION_NOT_FOUND" })
    await expect(
      docService.getSection({ workspaceId: wsId, userId: owner, docId: streamId(), blockId: block })
    ).rejects.toMatchObject({ status: 404 })
  })
})
