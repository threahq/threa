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
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { MessageRepository } from "../../src/features/messaging"
import {
  AttachmentReferenceRepository,
  AttachmentRepository,
  type InsertAttachmentParams,
} from "../../src/features/attachments"
import { resolveDeliveryGroups, streamGroup, type OutboxEvent } from "../../src/lib/outbox"
import { attachmentId, blockId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
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

async function seedAttachment(
  uploadedBy: string,
  overrides: Partial<Pick<InsertAttachmentParams, "safetyStatus" | "streamId" | "e2eOnly">> = {}
): Promise<string> {
  const id = attachmentId()
  await AttachmentRepository.insert(pool, {
    id,
    workspaceId: wsId,
    uploadedBy,
    filename: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 12,
    storagePath: `${wsId}/${id}/diagram.png`,
    safetyStatus: "clean",
    ...overrides,
  })
  return id
}

const attachmentParagraph = (ids: string[]): JSONContent => ({
  type: "paragraph",
  content: ids.map((id) => ({
    type: "attachmentReference",
    attrs: {
      id,
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 12,
      status: "uploaded",
      imageIndex: null,
      error: null,
      display: "inline",
    },
  })),
})

function post(docId: string, update: string, userIdForPost = owner) {
  return docService.postUpdate({ workspaceId: wsId, userId: userIdForPost, docId, update })
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
    const projection = projectDoc(server, doc.id)
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

  test("should append a doc:edited row to the doc stream when an update is posted", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const { seq, touchedBlockIds } = await post(doc.id, appendBlock(client.ydoc, paragraph("Edited", blockId())))

    const rows = (await StreamEventRepository.list(pool, wsId, doc.id, { viewerId: owner })).filter(
      (event) => event.eventType === "doc:edited"
    )
    expect(
      rows.map(({ eventType, payload, actorId, actorType }) => ({ eventType, payload, actorId, actorType }))
    ).toEqual([{ eventType: "doc:edited", payload: { seq, touchedBlockIds }, actorId: owner, actorType: "user" }])
  })

  test("should store nothing when the same update is posted twice", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const update = appendBlock(client.ydoc, paragraph("Sent twice", blockId()))

    const first = await post(doc.id, update)
    const second = await post(doc.id, update)

    const edited = (await StreamEventRepository.list(pool, wsId, doc.id, { viewerId: owner })).filter(
      (event) => event.eventType === "doc:edited"
    )
    expect({
      second,
      stored: (await DocRepository.listUpdatesAfter(pool, wsId, doc.id, 0)).map(({ seq, update }) => ({
        seq,
        update: encodeUpdateBase64(update),
      })),
      edited: edited.map((event) => event.payload),
      outbox: (await outboxRows("doc:updated", doc.id)).map((row) => (row.payload as { seq: number }).seq),
    }).toEqual({
      second: { seq: first.seq, applied: false, touchedBlockIds: [] },
      stored: [{ seq: first.seq, update }],
      edited: [{ seq: first.seq, touchedBlockIds: first.touchedBlockIds }],
      outbox: [first.seq],
    })
  })

  test("should answer the peer's head seq without storing when a client re-posts bytes the doc already holds", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const other = await openClient(doc.id, peer)
    const update = appendBlock(client.ydoc, paragraph("Mine", blockId()))
    const first = await post(doc.id, update)
    const peerWrite = await post(doc.id, appendBlock(other.ydoc, paragraph("Theirs", blockId())), peer)

    const again = await post(doc.id, update)

    expect({
      again,
      rows: (await DocRepository.listUpdatesAfter(pool, wsId, doc.id, 0)).map(({ seq }) => seq),
    }).toEqual({
      again: { seq: peerWrite.seq, applied: false, touchedBlockIds: [] },
      rows: [first.seq, peerWrite.seq],
    })
  })

  test("should store only the new bytes when a retry carries held and unsent edits together", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    const sent = decodeUpdateBase64(appendBlock(client.ydoc, paragraph("Sent", blockId())))
    const unsent = decodeUpdateBase64(appendBlock(client.ydoc, paragraph("Unsent", blockId())))
    const first = await post(doc.id, encodeUpdateBase64(sent))

    const retry = await post(doc.id, encodeUpdateBase64(Y.mergeUpdates([sent, unsent])))

    const stored = (await DocRepository.listUpdatesAfter(pool, wsId, doc.id, first.seq)).map((row) => row.update)
    const replayedOntoSent = new Y.Doc()
    Y.applyUpdate(replayedOntoSent, sent)
    for (const update of stored) Y.applyUpdate(replayedOntoSent, update)
    const replayedAlone = new Y.Doc()
    for (const update of stored) Y.applyUpdate(replayedAlone, update)
    expect({
      retry: { seq: retry.seq, applied: retry.applied },
      rows: stored.length,
      ontoSent: ydocToContentJson(replayedOntoSent),
      alone: ydocToContentJson(replayedAlone).content ?? [],
    }).toEqual({
      retry: { seq: first.seq + 1, applied: true },
      rows: 1,
      ontoSent: ydocToContentJson(client.ydoc),
      alone: [],
    })
  })

  test("should hide a private doc from a non-member who sends a state vector", async () => {
    const channel = await createChannel("private")
    const doc = await createDoc(channel.id)

    await expect(
      docService.get({
        workspaceId: wsId,
        userId: outsider,
        docId: doc.id,
        stateVector: encodeUpdateBase64(Y.encodeStateVector(new Y.Doc())),
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  test("should return only what the client lacks when given a state vector", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const writer = await openClient(doc.id, owner)
    const firstUpdate = appendBlock(writer.ydoc, paragraph("First", blockId()))
    await post(doc.id, firstUpdate)
    await post(doc.id, appendBlock(writer.ydoc, paragraph("Second", blockId())))

    const behind = new Y.Doc()
    Y.applyUpdate(behind, decodeUpdateBase64(firstUpdate))
    const { state: missing } = await docService.get({
      workspaceId: wsId,
      userId: owner,
      docId: doc.id,
      stateVector: encodeUpdateBase64(Y.encodeStateVector(behind)),
    })
    Y.applyUpdate(behind, decodeUpdateBase64(missing))

    const empty = new Y.Doc()
    const { state: everything } = await docService.get({
      workspaceId: wsId,
      userId: owner,
      docId: doc.id,
      stateVector: encodeUpdateBase64(Y.encodeStateVector(empty)),
    })
    Y.applyUpdate(empty, decodeUpdateBase64(everything))

    const server = await serverJson(doc.id)
    expect({ behind: ydocToContentJson(behind), empty: ydocToContentJson(empty) }).toEqual({
      behind: server,
      empty: server,
    })
    expect(decodeUpdateBase64(missing).length).toBeLessThan(decodeUpdateBase64(everything).length)
  })

  test("should reject a state vector that does not decode", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)

    await expect(
      docService.get({
        workspaceId: wsId,
        userId: owner,
        docId: doc.id,
        stateVector: encodeUpdateBase64(new Uint8Array([5, 1])),
      })
    ).rejects.toMatchObject({ status: 400, code: "DOC_STATE_VECTOR_INVALID" })
  })

  test("should refuse the update and leave the head when the bytes are not an applicable Yjs update", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const origin = await openClient(doc.id, owner)
    await post(doc.id, appendBlock(origin.ydoc, paragraph("Seen", blockId())))
    appendBlock(origin.ydoc, paragraph("Never posted", blockId()))
    const dependent = appendBlock(origin.ydoc, paragraph("Depends on it", blockId()))

    await expect(post(doc.id, Buffer.from("not a yjs update").toString("base64"))).rejects.toMatchObject({
      status: 400,
      code: "DOC_UPDATE_INVALID",
    })
    await expect(post(doc.id, dependent)).rejects.toMatchObject({ status: 400, code: "DOC_UPDATE_NOT_APPLICABLE" })
    const head = await DocRepository.findHead(pool, wsId, doc.id)
    expect({
      updateSeq: head?.updateSeq,
      bodyMarkdown: head?.bodyMarkdown,
      storedSeqs: (await DocRepository.listUpdatesAfter(pool, wsId, doc.id, 0)).map((update) => update.seq),
    }).toEqual({ updateSeq: 1, bodyMarkdown: "Seen", storedSeqs: [1] })
  })

  test("should repair the merged state and keep the later client in sync when two valid edits merge into a schema-invalid doc", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const setup = await openClient(doc.id, owner)
    const list: JSONContent = {
      type: "bulletList",
      attrs: { blockId: blockId() },
      content: [{ type: "listItem", content: [paragraph("a", blockId()), paragraph("b", blockId())] }],
    }
    const tail = paragraph("tail", blockId())
    await post(doc.id, encodeUpdateBase64(writeContentJson(setup.ydoc, { type: "doc", content: [list, tail] })))

    const alice = await openClient(doc.id, owner)
    const bob = await openClient(doc.id, peer)
    const withListItem = (content: JSONContent[]): JSONContent => ({
      type: "doc",
      content: [{ ...list, content: [{ type: "listItem", content }] }, tail],
    })
    const [first, second] = list.content![0]!.content!
    await post(doc.id, encodeUpdateBase64(writeContentJson(alice.ydoc, withListItem([second!]))), owner)
    const codeBlock: JSONContent = { type: "codeBlock", content: [{ type: "text", text: "b" }] }
    const merged = await post(
      doc.id,
      encodeUpdateBase64(writeContentJson(bob.ydoc, withListItem([first!, codeBlock]))),
      peer
    )
    await bob.sync()
    const later = await post(doc.id, appendBlock(bob.ydoc, paragraph("Bob later", blockId())), peer)
    await bob.sync()

    const updates = await docService.listUpdates({ workspaceId: wsId, userId: owner, docId: doc.id, after: 2 })
    const server = await serverJson(doc.id)
    const head = await DocRepository.findHead(pool, wsId, doc.id)
    const { sections } = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
    expect({
      merged: merged.seq,
      later: later.seq,
      actors: updates.map(({ seq, actorType }) => ({ seq, actorType })),
      server: server.content?.map((block) => block.type),
      bob: ydocToContentJson(bob.ydoc),
      projected: {
        bodyJson: head?.bodyJson,
        sections: sections.map(({ blockId, markdown }) => ({ blockId, markdown })),
      },
    }).toEqual({
      merged: 4,
      later: 5,
      actors: [
        { seq: 3, actorType: "user" },
        { seq: 4, actorType: "system" },
        { seq: 5, actorType: "user" },
      ],
      server: ["paragraph", "paragraph"],
      bob: server,
      projected: {
        bodyJson: server,
        sections: projectDoc(server, doc.id).sections.map(({ blockId, markdown }) => ({ blockId, markdown })),
      },
    })
  })

  test("should store both updates and both edits when two clients post concurrently", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const alice = await openClient(doc.id, owner)
    const bob = await openClient(doc.id, peer)

    const results = await Promise.all([
      post(doc.id, appendBlock(alice.ydoc, paragraph("Alice", blockId())), owner),
      post(doc.id, appendBlock(bob.ydoc, paragraph("Bob", blockId())), peer),
    ])

    const { sections } = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
    expect({
      seqs: results.map((result) => result.seq).sort(),
      text: sections.map((section) => section.markdown).sort(),
    }).toEqual({ seqs: [1, 2], text: ["Alice", "Bob"] })
  })

  test("should refuse a message with reason doc_stream when it is posted to a doc", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)

    await expect(
      new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: owner },
        { workspaceId: wsId, streamId: doc.id, authorId: owner, authorType: "user", ...testMessageContent("no") }
      )
    ).rejects.toMatchObject({ status: 403, code: "STREAM_READ_ONLY", details: { reason: "doc_stream" } })
  })

  test("should refuse a doc when the host is archived or a system stream", async () => {
    const archived = await createChannel("public")
    await streamService.archiveStream(archived.id, wsId, owner)
    const system = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: wsId,
      type: "system",
      visibility: "private",
      createdBy: owner,
    })
    await StreamMemberRepository.insert(pool, wsId, system.id, owner)

    await expect(createDoc(archived.id)).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "archived" },
    })
    await expect(createDoc(system.id)).rejects.toMatchObject({ status: 400, code: "DOC_HOST_TYPE_INVALID" })
  })

  test("should reproduce body and sections from a snapshot and refuse updates behind it when more than 200 updates were posted", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id)
    const client = await openClient(doc.id, owner)
    for (let index = 0; index <= DOC_SNAPSHOT_INTERVAL; index++) {
      await post(doc.id, appendBlock(client.ydoc, paragraph(`Line ${index}`, blockId())))
    }

    const updates = await DocRepository.listUpdatesAfter(pool, wsId, doc.id, 0)
    const replayed = projectDoc(
      ydocToContentJson(loadDocState({ snapshot: null, updates: updates.map((update) => update.update) })),
      doc.id
    )
    const read = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
    const head = await DocRepository.findHead(pool, wsId, doc.id)
    const tail = await docService.listUpdates({ workspaceId: wsId, userId: owner, docId: doc.id, after: 200 })
    await expect(
      docService.listUpdates({ workspaceId: wsId, userId: owner, docId: doc.id, after: 199 })
    ).rejects.toMatchObject({ status: 409, code: "DOC_UPDATES_BEHIND_SNAPSHOT" })
    expect({
      snapshotSeq: (await DocRepository.findLatestSnapshot(pool, wsId, doc.id))?.seq,
      tailSeqs: tail.map((update) => update.seq),
      seq: read.seq,
      state: projectDoc(
        ydocToContentJson(loadDocState({ snapshot: decodeUpdateBase64(read.state), updates: [] })),
        doc.id
      ),
      body: head?.bodyMarkdown,
      sections: read.sections,
    }).toEqual({
      snapshotSeq: 200,
      tailSeqs: [201],
      seq: 201,
      state: replayed,
      body: replayed.bodyMarkdown,
      sections: replayed.sections,
    })
  })

  test("should bind only the poster's own unbound, shareable, plaintext uploads to the doc when an update references attachments", async () => {
    const channel = await createChannel("private")
    const doc = await createDoc(channel.id)
    const own = await seedAttachment(owner)
    const others = await seedAttachment(peer)
    const sent = await seedAttachment(owner)
    const quarantined = await seedAttachment(owner, { safetyStatus: "quarantined" })
    const elsewhere = await seedAttachment(owner, { streamId: channel.id })
    const sealed = await seedAttachment(owner, { safetyStatus: "e2e_unscanned", e2eOnly: true })
    const sentMessage = messageId()
    await AttachmentRepository.attachToMessage(pool, wsId, [sent], sentMessage, channel.id)
    const client = await openClient(doc.id, owner)
    const ids = [own, others, sent, quarantined, elsewhere, sealed]

    await post(doc.id, appendBlock(client.ydoc, attachmentParagraph(ids)))

    const bindings = Object.fromEntries(
      (await AttachmentRepository.findByIds(pool, wsId, ids)).map((row) => [
        row.id,
        { streamId: row.streamId, messageId: row.messageId },
      ])
    )
    expect({
      bindings,
      memberReads: (await streamService.tryAccess(doc.id, wsId, peer))?.id ?? null,
      outsiderReads: (await streamService.tryAccess(doc.id, wsId, outsider))?.id ?? null,
    }).toEqual({
      bindings: {
        [own]: { streamId: doc.id, messageId: null },
        [others]: { streamId: null, messageId: null },
        [sent]: { streamId: channel.id, messageId: sentMessage },
        [quarantined]: { streamId: null, messageId: null },
        [elsewhere]: { streamId: channel.id, messageId: null },
        [sealed]: { streamId: null, messageId: null },
      },
      memberReads: doc.id,
      outsiderReads: null,
    })
  })

  test("should reference a doc-bound image without re-pointing it when a message elsewhere attaches it", async () => {
    const host = await createChannel("private")
    const doc = await createDoc(host.id)
    const image = await seedAttachment(owner)
    const client = await openClient(doc.id, owner)
    await post(doc.id, appendBlock(client.ydoc, attachmentParagraph([image])))
    const other = await createChannel("private")
    const outsiderChannel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `docs-outsider-${++slugCounter}`,
      visibility: "public",
      createdBy: outsider,
      memberIds: [],
    })
    const eventService = new EventService(pool)

    const { message } = await eventService.createMessageForPrincipalReturningConversation(
      { kind: "user", userId: owner },
      {
        workspaceId: wsId,
        streamId: other.id,
        authorId: owner,
        authorType: "user",
        ...testMessageContent("see the doc image"),
        attachmentIds: [image],
      }
    )
    const row = (await AttachmentRepository.findById(pool, wsId, image))!
    const references = await AttachmentReferenceRepository.findByAttachmentId(pool, wsId, image)

    expect({
      binding: { streamId: row.streamId, messageId: row.messageId },
      references: references.map((ref) => ({ messageId: ref.messageId, streamId: ref.streamId })),
    }).toEqual({
      binding: { streamId: doc.id, messageId: null },
      references: [{ messageId: message.id, streamId: other.id }],
    })
    await expect(
      eventService.createMessageForPrincipalReturningConversation(
        { kind: "user", userId: outsider },
        {
          workspaceId: wsId,
          streamId: outsiderChannel.id,
          authorId: outsider,
          authorType: "user",
          ...testMessageContent("stolen"),
          attachmentIds: [image],
        }
      )
    ).rejects.toThrow("cannot reference an attachment without read access")
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

describe("DocService.listBacklinks", () => {
  const docEmbed = (docId: string): JSONContent => ({ type: "docEmbed", attrs: { docId, blockId: null, title: "B" } })
  const embedParagraph = (docId: string, id: string): JSONContent => ({
    type: "paragraph",
    attrs: { blockId: id },
    content: [{ type: "text", text: "See " }, docEmbed(docId)],
  })

  test("should list readable referencing docs with their blocks when a doc embeds another", async () => {
    const privateHost = await createChannel("private")
    const publicHost = await createChannel("public")
    const docA = await createDoc(privateHost.id)
    const docB = await createDoc(publicHost.id)
    const client = await openClient(docA.id, owner)
    const [first, second] = [blockId(), blockId()].sort()
    const json = ydocToContentJson(client.ydoc)
    await post(
      docA.id,
      encodeUpdateBase64(
        writeContentJson(client.ydoc, {
          ...json,
          content: [...(json.content ?? []), embedParagraph(docB.id, first!), embedParagraph(docB.id, second!)],
        })
      )
    )

    const backlinks = (userIdForRead: string) =>
      docService.listBacklinks({ workspaceId: wsId, userId: userIdForRead, docId: docB.id })
    expect({ owner: await backlinks(owner), outsider: await backlinks(outsider) }).toEqual({
      owner: [{ docId: docA.id, title: docA.displayName, hostStreamId: privateHost.id, blockIds: [first, second] }],
      outsider: [],
    })
  })

  test("should drop the backlink when a later write removes the embeds", async () => {
    const host = await createChannel("private")
    const docA = await createDoc(host.id)
    const docB = await createDoc(host.id)
    const client = await openClient(docA.id, owner)
    const json = ydocToContentJson(client.ydoc)
    const embedded = { ...json, content: [...(json.content ?? []), embedParagraph(docB.id, blockId())] }
    await post(docA.id, encodeUpdateBase64(writeContentJson(client.ydoc, embedded)))
    const before = await docService.listBacklinks({ workspaceId: wsId, userId: owner, docId: docB.id })

    await post(docA.id, encodeUpdateBase64(writeContentJson(client.ydoc, { ...embedded, content: json.content ?? [] })))

    expect({
      before: before.map((backlink) => backlink.docId),
      after: await docService.listBacklinks({ workspaceId: wsId, userId: owner, docId: docB.id }),
    }).toEqual({ before: [docA.id], after: [] })
  })

  test("should hide a referencing doc when its host is archived", async () => {
    const hostA = await createChannel("private")
    const hostB = await createChannel("private")
    const docA = await createDoc(hostA.id)
    const docB = await createDoc(hostB.id)
    const client = await openClient(docA.id, owner)
    const json = ydocToContentJson(client.ydoc)
    const embedded = { ...json, content: [...(json.content ?? []), embedParagraph(docB.id, blockId())] }
    await post(docA.id, encodeUpdateBase64(writeContentJson(client.ydoc, embedded)))
    const before = await docService.listBacklinks({ workspaceId: wsId, userId: owner, docId: docB.id })

    await streamService.archiveStream(hostA.id, wsId, owner)

    expect({
      before: before.map((backlink) => backlink.docId),
      after: await docService.listBacklinks({ workspaceId: wsId, userId: owner, docId: docB.id }),
    }).toEqual({ before: [docA.id], after: [] })
  })
})
