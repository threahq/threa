/**
 * Explorer search over files embedded in docs, against the real schema (INV-68): a doc's files list under
 * the doc and under its host like a thread's do, only for readers of the doc (INV-62), and only while the
 * doc's current body still embeds them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import type { JSONContent, Stream } from "@threahq/types"
import { DocService, decodeUpdateBase64, encodeUpdateBase64, writeContentJson } from "../../src/features/docs"
import { StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { AttachmentRepository } from "../../src/features/attachments"
import { attachmentId, blockId, messageId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string
let peer: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("doc-attachment-search")
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
      name: "Doc Attachment Search Workspace",
      slug: `doc-attachment-search-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createPrivateChannel(): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `doc-files-${++slugCounter}`,
    visibility: "private",
    createdBy: owner,
    memberIds: [peer],
  })
}

async function seedAttachment(filename: string): Promise<string> {
  const id = attachmentId()
  await AttachmentRepository.insert(pool, {
    id,
    workspaceId: wsId,
    uploadedBy: owner,
    filename,
    mimeType: "image/png",
    sizeBytes: 12,
    storagePath: `${wsId}/${id}/${filename}`,
    safetyStatus: "clean",
  })
  return id
}

const attachmentBlock = (id: string, ...attachmentIds: string[]): JSONContent => ({
  type: "paragraph",
  attrs: { blockId: id },
  content: attachmentIds.map((attachment) => ({
    type: "attachmentReference",
    attrs: {
      id: attachment,
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

async function openWriter(docId: string) {
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  return (blocks: JSONContent[]) =>
    docService.postUpdate({
      workspaceId: wsId,
      userId: owner,
      docId,
      update: encodeUpdateBase64(writeContentJson(ydoc, { type: "doc", content: blocks })),
    })
}

async function browse(viewer: string, streamIds?: string[]) {
  const rows = await AttachmentRepository.search(pool, { workspaceId: wsId, userId: viewer, streamIds, limit: 50 })
  return rows
    .map((row) => ({ id: row.id, messageId: row.messageId, docBlockId: row.docBlockId }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

describe("AttachmentRepository.search over doc files", () => {
  test("should list a doc's embedded files under the doc and its host for readers only, and drop a file once no block embeds it", async () => {
    const host = await createPrivateChannel()
    const doc = await streamService.create({
      workspaceId: wsId,
      type: "doc",
      parentStreamId: host.id,
      createdBy: owner,
    })
    const kept = await seedAttachment("kept.png")
    const removed = await seedAttachment("removed.png")
    const hostFile = await seedAttachment("host.png")
    const hostMessage = messageId()
    await AttachmentRepository.attachToMessage(pool, wsId, [hostFile], hostMessage, host.id)
    const [first, second, third] = [blockId(), blockId(), blockId()]
    const write = await openWriter(doc.id)

    await write([attachmentBlock(first, kept), attachmentBlock(second, removed), attachmentBlock(third, kept)])
    const embedded = {
      docBrowse: await browse(peer, [doc.id]),
      hostBrowse: await browse(peer, [host.id]),
      outsiderWorkspace: await browse(outsider),
      outsiderDoc: await browse(outsider, [doc.id]),
    }

    await write([attachmentBlock(third, kept)])
    const afterRemoval = {
      docBrowse: await browse(peer, [doc.id]),
      hostBrowse: await browse(peer, [host.id]),
    }

    const keptRow = (docBlockId: string) => ({ id: kept, messageId: null, docBlockId })
    const removedRow = { id: removed, messageId: null, docBlockId: second }
    const hostRow = { id: hostFile, messageId: hostMessage, docBlockId: null }
    const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id))
    expect({ embedded, afterRemoval }).toEqual({
      embedded: {
        docBrowse: sorted([keptRow(first), removedRow]),
        hostBrowse: sorted([keptRow(first), removedRow, hostRow]),
        outsiderWorkspace: [],
        outsiderDoc: [],
      },
      afterRemoval: {
        docBrowse: [keptRow(third)],
        hostBrowse: sorted([keptRow(third), hostRow]),
      },
    })
  })
})
