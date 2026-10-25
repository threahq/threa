/**
 * Doc create and edit paths against the real schema (INV-68): creation under a
 * host, Yjs updates from concurrent clients converging on the server state,
 * server-stamped block ids, the write gate, snapshot replay, and the outbox
 * rows each write leaves for the dispatcher.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import type { DocCreatedEventPayload, JSONContent, Stream } from "@threahq/types"
import {
  DOC_SNAPSHOT_INTERVAL,
  DocRepository,
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  loadDocState,
  projectDoc,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import { StreamEventRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { MessageRepository } from "../../src/features/messaging"
import { resolveDeliveryGroups, streamGroup, type OutboxEvent } from "../../src/lib/outbox"
import { blockId, messageId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, testMessageContent, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string
let peer: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-service")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    peer = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs Service Test Workspace",
      slug: `docs-service-ws-${wsId.toLowerCase()}`,
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
    slug: `docs-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds: [peer],
  })
}

function createDoc(hostId: string, createdBy = owner): Promise<Stream> {
  return streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: hostId, createdBy })
}

const paragraph = (text: string, id?: string): JSONContent => ({
  type: "paragraph",
  ...(id && { attrs: { blockId: id } }),
  content: [{ type: "text", text }],
})

function appendBlock(ydoc: Y.Doc, block: JSONContent): string {
  const json = ydocToContentJson(ydoc)
  return encodeUpdateBase64(writeContentJson(ydoc, { ...json, content: [...(json.content ?? []), block] }))
}

/** A client that tracks the server's log the way a reconnecting tab does. */
async function openClient(docId: string, userIdForClient: string) {
  const { state, seq } = await docService.get({ workspaceId: wsId, userId: userIdForClient, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  let seen = seq
  return {
    ydoc,
    async sync() {
      const updates = await docService.listUpdates({ workspaceId: wsId, userId: userIdForClient, docId, after: seen })
      for (const update of updates) Y.applyUpdate(ydoc, decodeUpdateBase64(update.update))
      seen = updates.at(-1)?.seq ?? seen
    },
  }
}

function post(docId: string, update: string, actorId = owner) {
  return docService.postUpdate({ workspaceId: wsId, actorId, actorType: "user", docId, update })
}

async function serverJson(docId: string): Promise<JSONContent> {
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId })
  return ydocToContentJson(loadDocState({ snapshot: decodeUpdateBase64(state), updates: [] }))
}

async function outboxRows(eventType: string, streamId: string): Promise<OutboxEvent[]> {
  const result = await pool.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
    `SELECT id, event_type, payload FROM outbox WHERE event_type = $1 AND payload->>'streamId' = $2 ORDER BY id`,
    [eventType, streamId]
  )
  return result.rows.map(
    (row) =>
      ({ id: BigInt(row.id), eventType: row.event_type, payload: row.payload, createdAt: new Date() }) as OutboxEvent
  )
}

describe("DocService", () => {
  test("should converge two clients and the stored projection when they post interleaved updates", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const alice = await openClient(doc.id, owner)
    const bob = await openClient(doc.id, peer)

    await post(doc.id, appendBlock(alice.ydoc, paragraph("Alice one", blockId())), owner)
    await post(doc.id, appendBlock(bob.ydoc, paragraph("Bob one", blockId())), peer)
    await alice.sync()
    await post(doc.id, appendBlock(alice.ydoc, paragraph("Alice two", blockId())), owner)
    await post(doc.id, appendBlock(bob.ydoc, paragraph("Bob two", blockId())), peer)
    await alice.sync()
    await bob.sync()

    const server = await serverJson(doc.id)
    const projection = projectDoc(server)
    expect({
      alice: ydocToContentJson(alice.ydoc),
      bob: ydocToContentJson(bob.ydoc),
      blocks: server.content?.length,
      body: (await DocRepository.findHead(pool, wsId, doc.id))?.bodyMarkdown,
      sections: await DocRepository.listSections(pool, wsId, doc.id),
    }).toEqual({
      alice: server,
      bob: server,
      blocks: 4,
      body: projection.bodyMarkdown,
      sections: projection.sections,
    })
  })

  test("should stamp a unique block id as a system update when a client posts a block without one", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)

    const duplicated = blockId()
    await post(doc.id, appendBlock(client.ydoc, paragraph("Has an id", duplicated)))
    const result = await post(doc.id, appendBlock(client.ydoc, paragraph("Copied the id", duplicated)))
    const unstamped = await post(doc.id, appendBlock(client.ydoc, paragraph("No id")))
    await client.sync()

    const updates = await docService.listUpdates({ workspaceId: wsId, userId: owner, docId: doc.id, after: 0 })
    const ids = (await serverJson(doc.id)).content?.map((block) => block.attrs?.blockId)
    expect({
      seqs: [result.seq, unstamped.seq],
      actors: updates.map(({ seq, actorType }) => ({ seq, actorType })),
      uniqueIds: new Set(ids).size,
      allStamped: ids?.every((id) => typeof id === "string" && id.startsWith("blk_")),
      client: ydocToContentJson(client.ydoc),
    }).toEqual({
      seqs: [3, 5],
      actors: [
        { seq: 1, actorType: "user" },
        { seq: 2, actorType: "user" },
        { seq: 3, actorType: "system" },
        { seq: 4, actorType: "user" },
        { seq: 5, actorType: "system" },
      ],
      uniqueIds: 3,
      allStamped: true,
      client: await serverJson(doc.id),
    })
  })

  test("should hide a doc under a private channel when a non-member reads or writes it", async () => {
    const channel = await createChannel("private")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const update = appendBlock(client.ydoc, paragraph("Members only", blockId()))

    await expect(docService.get({ workspaceId: wsId, userId: outsider, docId: doc.id })).rejects.toMatchObject({
      status: 404,
    })
    await expect(post(doc.id, update, outsider)).rejects.toMatchObject({ status: 404 })
  })

  test("should let a public-channel non-member read but not write when they are not a member", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    await post(doc.id, appendBlock(client.ydoc, paragraph("Readable", blockId())))

    const read = await docService.get({ workspaceId: wsId, userId: outsider, docId: doc.id })
    expect(read.sections.map((section) => section.markdown)).toEqual(["Readable"])
    await expect(
      post(doc.id, appendBlock(client.ydoc, paragraph("Not yours", blockId())), outsider)
    ).rejects.toMatchObject({ status: 403, code: "STREAM_READ_ONLY", details: { reason: "not_a_member" } })
  })

  test("should refuse a doc when the host is a thread or end-to-end encrypted", async () => {
    const channel = await createChannel("public")
    const anchor = messageId()
    await withTransaction(pool, (client) =>
      MessageRepository.insert(client, {
        workspaceId: wsId,
        id: anchor,
        streamId: channel.id,
        sequence: 1n,
        authorId: owner,
        authorType: "user",
        ...testMessageContent("anchor"),
      })
    )
    const thread = await streamService.createThreadInternal({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchor,
      createdBy: owner,
    })
    const sealed = await streamService.createScratchpad({
      workspaceId: wsId,
      createdBy: owner,
      e2e: { ownerKeyId: "e2ek_docs_test" },
    })

    await expect(createDoc(thread.id)).rejects.toMatchObject({ status: 400, code: "DOC_HOST_TYPE_INVALID" })
    await expect(createDoc(sealed.id)).rejects.toMatchObject({ status: 400, code: "DOC_E2E_HOST_NOT_ALLOWED" })
  })

  test("should reproduce body and sections from a snapshot when more than 200 updates were posted", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    for (let index = 0; index <= DOC_SNAPSHOT_INTERVAL; index++) {
      await post(doc.id, appendBlock(client.ydoc, paragraph(`Line ${index}`, blockId())))
    }

    const updates = await docService.listUpdates({ workspaceId: wsId, userId: owner, docId: doc.id, after: 0 })
    const replayed = projectDoc(
      ydocToContentJson(
        loadDocState({ snapshot: null, updates: updates.map((update) => decodeUpdateBase64(update.update)) })
      )
    )
    const read = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
    const head = await DocRepository.findHead(pool, wsId, doc.id)
    expect({
      snapshotSeq: (await DocRepository.findLatestSnapshot(pool, wsId, doc.id))?.seq,
      headSnapshotSeq: head?.snapshotSeq,
      seq: read.seq,
      state: projectDoc(ydocToContentJson(loadDocState({ snapshot: decodeUpdateBase64(read.state), updates: [] }))),
      body: head?.bodyMarkdown,
      sections: read.sections,
    }).toEqual({
      snapshotSeq: 200,
      headSnapshotSeq: 200,
      seq: 201,
      state: replayed,
      body: replayed.bodyMarkdown,
      sections: replayed.sections,
    })
  })

  test("should write a broadcast doc:created row in the host and route outbox rows when a doc is created and edited", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const { seq, touchedBlockIds } = await post(doc.id, appendBlock(client.ydoc, paragraph("Routed", blockId())))

    const hostRows = (await StreamEventRepository.list(pool, wsId, channel.id, { viewerId: peer })).filter(
      (event) => event.eventType === "doc:created"
    )
    const created = (await outboxRows("stream:created", doc.id))[0]!
    const docCreated = (await outboxRows("stream:doc_created", channel.id))[0]!
    const updated = await outboxRows("doc:updated", doc.id)

    expect(hostRows).toHaveLength(1)
    expect(hostRows[0]!.broadcastSequence).not.toBeNull()
    expect({
      stream: { type: doc.type, parentStreamId: doc.parentStreamId, rootStreamId: doc.rootStreamId },
      hostRow: hostRows[0]!.payload,
      outboxEventId: (docCreated.payload as { event: { id: string } }).event.id,
      routes: {
        created: resolveDeliveryGroups(created),
        docCreated: resolveDeliveryGroups(docCreated),
        updated: updated.map(resolveDeliveryGroups),
      },
      updated: updated.map((event) => event.payload),
    }).toEqual({
      stream: { type: "doc", parentStreamId: channel.id, rootStreamId: channel.id },
      hostRow: { docId: doc.id, createdBy: owner } satisfies DocCreatedEventPayload,
      outboxEventId: hostRows[0]!.id,
      routes: {
        created: [streamGroup(channel.id)],
        docCreated: [streamGroup(channel.id)],
        updated: [[streamGroup(doc.id)]],
      },
      updated: [
        {
          workspaceId: wsId,
          streamId: doc.id,
          seq,
          update: expect.any(String),
          touchedBlockIds,
          actorId: owner,
          actorType: "user",
        },
      ],
    })
  })
})
