/**
 * Moving a doc against the real schema (INV-68): the doc and its section threads take the new root's
 * access (INV-62), both hosts get a `doc:moved` row, share grants stay, and unrolled edits fold into the
 * new host without naming an author who can no longer read the doc.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import {
  DocErrorCodes,
  StreamErrorCodes,
  type DocActivityEventPayload,
  type JSONContent,
  type Stream,
} from "@threahq/types"
import {
  DOC_ACTIVITY_QUIET_MS,
  DocActivityService,
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import {
  StreamEventRepository,
  StreamService,
  checkStreamAccess,
  listAccessibleStreamIds,
  type MoveDocParams,
} from "../../src/features/streams"
import { BotChannelService } from "../../src/features/api-keys"
import { BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, botRuntimeSessionLinkId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let eventService: EventService
let wsId: string
let owner: string
let alice: string
let bob: string
let carol: string
let admin: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-move")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  eventService = new EventService(pool)
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    alice = (await addTestMember(client, wsId, userId())).id
    bob = (await addTestMember(client, wsId, userId())).id
    carol = (await addTestMember(client, wsId, userId())).id
    admin = (await addTestMember(client, wsId, userId(), "admin")).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs Move Test Workspace",
      slug: `docs-move-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createChannel(memberIds: string[], visibility: "public" | "private" = "private"): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `docs-move-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
}

async function write(docId: string, actor: string, text: string): Promise<string> {
  const { state } = await docService.get({ workspaceId: wsId, userId: actor, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const block = blockId()
  const json = ydocToContentJson(ydoc)
  const paragraph: JSONContent = { type: "paragraph", attrs: { blockId: block }, content: [{ type: "text", text }] }
  const update = encodeUpdateBase64(writeContentJson(ydoc, { ...json, content: [...(json.content ?? []), paragraph] }))
  await docService.postUpdate({ workspaceId: wsId, userId: actor, docId, update })
  return block
}

/** Private channels A {owner, alice} and B {owner, bob}; a doc in A with one block and its comment thread. */
async function seed() {
  const a = await createChannel([alice])
  const b = await createChannel([bob])
  const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: a.id, createdBy: owner })
  const block = await write(doc.id, owner, "Plan")
  const thread = await streamService.createThread({
    workspaceId: wsId,
    parentStreamId: doc.id,
    parentAnchorId: block,
    createdBy: owner,
    principal: { kind: "user", userId: owner },
  })
  return { a, b, doc, thread }
}

function move(params: Partial<MoveDocParams> & Pick<MoveDocParams, "docId" | "toStreamId">) {
  return streamService.moveDoc({
    workspaceId: wsId,
    principal: { kind: "user", userId: owner },
    isWorkspaceAdmin: false,
    ...params,
  })
}

async function readers(streamIds: string[]) {
  const entries = await Promise.all(
    [alice, bob].map(async (user) => [user, [...(await listAccessibleStreamIds(pool, wsId, user, streamIds))].sort()])
  )
  return Object.fromEntries(entries)
}

async function contextRows(refOrStream: string) {
  const result = await pool.query<{ stream_id: string; root_stream_id: string; category: string; ref_id: string }>(
    `SELECT stream_id, root_stream_id, category, ref_id FROM stream_context_items
     WHERE workspace_id = $1 AND (ref_id = $2 OR stream_id = $2) ORDER BY stream_id, category`,
    [wsId, refOrStream]
  )
  return result.rows
}

async function outbox(eventType: string, docId: string) {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM outbox WHERE event_type = $1
       AND (payload->>'streamId' = $2 OR payload->'doc'->>'id' = $2) ORDER BY id`,
    [eventType, docId]
  )
  return result.rows.map((row) => row.payload)
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    const { status, code } = error as { status?: number; code?: string }
    return { status, code }
  }
  return null
}

describe("moving a doc", () => {
  test("should re-root the doc and its section threads on the target so access follows the new root", async () => {
    const { a, b, doc, thread } = await seed()
    const before = await readers([doc.id, thread.id])

    const moved = await move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id })

    const threadRow = await streamService.getStreamById(wsId, thread.id)
    expect({
      before,
      after: await readers([doc.id, thread.id]),
      // Bob joined neither the thread nor the doc: the thread reads through B, its root (INV-62).
      bobReadsThread: (await checkStreamAccess(pool, thread.id, wsId, bob))?.id ?? null,
      doc: { parentStreamId: moved.parentStreamId, rootStreamId: moved.rootStreamId, visibility: moved.visibility },
      thread: { parentStreamId: threadRow?.parentStreamId, rootStreamId: threadRow?.rootStreamId },
    }).toEqual({
      before: { [alice]: [doc.id, thread.id].sort(), [bob]: [] },
      after: { [alice]: [], [bob]: [doc.id, thread.id].sort() },
      bobReadsThread: thread.id,
      doc: { parentStreamId: b.id, rootStreamId: b.id, visibility: "private" },
      thread: { parentStreamId: doc.id, rootStreamId: b.id },
    })
  })

  test("should write a doc:moved row in both hosts, re-home context rows and queue the eviction", async () => {
    const { a, b, doc, thread } = await seed()
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: thread.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "spec", marks: [{ type: "link", attrs: { href: "https://example.com/spec" } }] },
            ],
          },
        ],
      },
      contentMarkdown: "[spec](https://example.com/spec)",
    })

    await move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id })

    const movedRows = async (hostId: string) =>
      (await StreamEventRepository.list(pool, wsId, hostId, { types: ["doc:moved"] })).map((event) => ({
        actorId: event.actorId,
        payload: event.payload,
      }))
    const expectedRow = { actorId: owner, payload: { docId: doc.id, fromStreamId: a.id, toStreamId: b.id } }
    const docMoved = await outbox("stream:doc_moved", doc.id)
    expect({
      inA: await movedRows(a.id),
      inB: await movedRows(b.id),
      context: await contextRows(doc.id),
      threadContext: (await contextRows(thread.id)).map((row) => [row.category, row.root_stream_id]),
      docMoved: docMoved.map((payload) => ({
        streamId: payload.streamId,
        movedStreamIds: [...payload.movedStreamIds].sort(),
      })),
      narrowed: await outbox("access:narrowed", doc.id),
    }).toEqual({
      inA: [expectedRow],
      inB: [expectedRow],
      context: [{ stream_id: b.id, root_stream_id: b.id, category: "doc", ref_id: doc.id }],
      threadContext: [["link", b.id]],
      docMoved: [
        { streamId: a.id, movedStreamIds: [doc.id, thread.id].sort() },
        { streamId: b.id, movedStreamIds: [doc.id, thread.id].sort() },
      ],
      narrowed: [{ workspaceId: wsId, streamId: doc.id }],
    })
  })

  test("should end a runtime session linked to a moved section thread", async () => {
    const { a, b, doc, thread } = await seed()
    const link = await BotRuntimeSessionLinkRepository.upsert(pool, {
      id: botRuntimeSessionLinkId(),
      workspaceId: wsId,
      botId: "bot_docs_move",
      runtimeKind: "pi-local",
      instanceId: "inst_docs_move",
      runtimeSessionId: "sess_docs_move",
      rootStreamId: a.id,
      activeStreamId: thread.id,
      linkedBy: owner,
    })

    await move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id })

    const status = await pool.query<{ status: string }>("SELECT status FROM bot_runtime_session_links WHERE id = $1", [
      link.id,
    ])
    const notified = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox WHERE event_type = 'bot:session_archived' AND payload->>'runtimeSessionId' = $1",
      ["sess_docs_move"]
    )
    expect({ status: status.rows[0]?.status, notified: notified.rows.map((row) => row.payload.rootStreamId) }).toEqual({
      status: "archived",
      notified: [a.id],
    })
  })

  test("should keep a reader whose access rides a share grant", async () => {
    const { a, b, doc } = await seed()
    const c = await createChannel([carol])
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: c.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: doc.id, title: "Plan" } }] }],
      },
      contentMarkdown: "shared",
      confirmedPrivacyWarning: true,
    })

    const preview = await streamService.previewDocMove({
      workspaceId: wsId,
      docId: doc.id,
      toStreamId: b.id,
      userId: owner,
    })
    await move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id })

    expect({
      preview,
      carolReads: (await checkStreamAccess(pool, doc.id, wsId, carol))?.id ?? null,
      aliceReads: (await checkStreamAccess(pool, doc.id, wsId, alice))?.id ?? null,
    }).toEqual({ preview: { losing: 1, gaining: 1 }, carolReads: doc.id, aliceReads: null })
  })

  test("should count no change when moving between public channels everyone can browse", async () => {
    const a = await createChannel([], "public")
    const b = await createChannel([], "public")
    const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: a.id, createdBy: owner })

    expect(
      await streamService.previewDocMove({ workspaceId: wsId, docId: doc.id, toStreamId: b.id, userId: owner })
    ).toEqual({ losing: 0, gaining: 0 })
  })

  test("should let a workspace admin who did not create the doc move it", async () => {
    const a = await createChannel([admin])
    const b = await createChannel([admin])
    const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: a.id, createdBy: owner })

    const moved = await move({
      docId: doc.id,
      fromStreamId: a.id,
      toStreamId: b.id,
      principal: { kind: "user", userId: admin },
      isWorkspaceAdmin: true,
    })

    expect(moved.parentStreamId).toBe(b.id)
  })

  test("should refuse a mover who is neither the creator nor an admin, even with write on both streams", async () => {
    const a = await createChannel([alice])
    const b = await createChannel([alice])
    const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: a.id, createdBy: owner })

    expect(
      await refusal(
        move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id, principal: { kind: "user", userId: alice } })
      )
    ).toEqual({ status: 403, code: DocErrorCodes.MOVE_FORBIDDEN })
  })

  test("should refuse stale, unreachable, non-hosting and archived targets", async () => {
    const { a, b, doc, thread } = await seed()
    const unreadable = await streamService.createChannel({
      workspaceId: wsId,
      slug: `docs-move-${++slugCounter}`,
      visibility: "private",
      createdBy: bob,
    })
    const archived = await createChannel([])
    await streamService.archiveStream(archived.id, wsId, owner)

    expect({
      stale: await refusal(move({ docId: doc.id, fromStreamId: b.id, toStreamId: b.id })),
      unreadable: await refusal(move({ docId: doc.id, fromStreamId: a.id, toStreamId: unreadable.id })),
      thread: await refusal(move({ docId: doc.id, fromStreamId: a.id, toStreamId: thread.id })),
      archived: await refusal(move({ docId: doc.id, fromStreamId: a.id, toStreamId: archived.id })),
      sameHost: (await move({ docId: doc.id, fromStreamId: a.id, toStreamId: a.id })).parentStreamId,
    }).toEqual({
      stale: { status: 409, code: DocErrorCodes.MOVED_CONCURRENTLY },
      unreadable: { status: 404, code: expect.any(String) },
      thread: { status: 400, code: DocErrorCodes.HOST_TYPE_INVALID },
      archived: { status: 403, code: StreamErrorCodes.READ_ONLY },
      sameHost: a.id,
    })
    expect(await StreamEventRepository.list(pool, wsId, a.id, { types: ["doc:moved"] })).toEqual([])
  })

  test("should fold edits made before the move into the new host, leaving out an author who lost access", async () => {
    const { a, b, doc } = await seed()
    const activity = new DocActivityService({
      pool,
      jobQueue: { send: async () => "queued" } as never,
      botChannelService: new BotChannelService({ pool }),
      now: () => new Date(Date.now() + DOC_ACTIVITY_QUIET_MS * 2),
    })
    await activity.rollUp({ workspaceId: wsId, docId: doc.id })
    await write(doc.id, alice, "Alice's line")
    await write(doc.id, owner, "Owner's line")

    await move({ docId: doc.id, fromStreamId: a.id, toStreamId: b.id })
    await activity.rollUp({ workspaceId: wsId, docId: doc.id })

    const rows = async (hostId: string) =>
      (await StreamEventRepository.list(pool, wsId, hostId, { types: ["doc:activity"] })).map(
        (event) => (event.payload as DocActivityEventPayload).actors
      )
    expect({ a: (await rows(a.id)).length, b: await rows(b.id) }).toEqual({
      a: 1,
      b: [[{ actorId: owner, actorType: "user" }]],
    })
  })
})
