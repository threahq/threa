/**
 * The workspace doc list against the real schema (INV-68): readable,
 * non-archived docs with who edited them, newest edit first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import { AuthorTypes, type JSONContent, type Stream } from "@threahq/types"
import {
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, personaId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let eventService: EventService
let wsId: string
let owner: string
let peer: string
let viewer: string
const persona = personaId()

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-list")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  eventService = new EventService(pool)
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    peer = (await addTestMember(client, wsId, userId())).id
    viewer = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Docs List Test Workspace",
      slug: `docs-list-ws-${wsId.toLowerCase()}`,
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
    slug: `docs-list-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
}

function createDoc(hostId: string): Promise<Stream> {
  return streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: hostId, createdBy: owner })
}

async function typeInto(docId: string, editor: string, value: string): Promise<void> {
  const { state } = await docService.get({ workspaceId: wsId, userId: editor, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const json = ydocToContentJson(ydoc)
  const block: JSONContent = { type: "paragraph", content: [{ type: "text", text: value }] }
  const update = encodeUpdateBase64(writeContentJson(ydoc, { ...json, content: [...(json.content ?? []), block] }))
  await docService.postUpdate({ workspaceId: wsId, userId: editor, docId, update })
}

async function listFor(user: string) {
  return docService.list({ workspaceId: wsId, userId: user })
}

describe("DocService.list", () => {
  test("should list a readable doc with its editors newest first when several actors edited it", async () => {
    const host = await createChannel("public", [peer])
    const doc = await createDoc(host.id)
    await typeInto(doc.id, owner, "first")
    await typeInto(doc.id, peer, "second")
    await docService.applyAgentRewrite({
      workspaceId: wsId,
      docId: doc.id,
      principal: { kind: "user", userId: owner },
      actor: { actorId: persona, actorType: AuthorTypes.PERSONA },
      reason: "tidy",
      rewrite: () => ({ ok: true, sections: [{ changed: true, blockId: blockId(), markdown: "rewritten" }] }),
    })
    await typeInto(doc.id, owner, "third")

    const item = (await listFor(viewer)).find((entry) => entry.id === doc.id)

    expect({
      editors: item?.editors.map(({ actorId, actorType }) => ({ actorId, actorType })),
      lastEditedAt: item?.lastEditedAt,
    }).toEqual({
      editors: [
        { actorId: owner, actorType: AuthorTypes.USER },
        { actorId: persona, actorType: AuthorTypes.PERSONA },
        { actorId: peer, actorType: AuthorTypes.USER },
      ],
      lastEditedAt: item?.editors[0]?.lastEditedAt,
    })
  })

  test("should list a never-edited doc with no editors and a null last edit", async () => {
    const doc = await createDoc((await createChannel("public")).id)

    expect((await listFor(viewer)).find((entry) => entry.id === doc.id)).toEqual({
      id: doc.id,
      displayName: null,
      createdAt: new Date(doc.createdAt).toISOString(),
      isTopLevel: false,
      lastEditedAt: null,
      editors: [],
    })
  })

  test("should exclude a doc when it sits under a private channel the viewer cannot read", async () => {
    const doc = await createDoc((await createChannel("private")).id)

    expect((await listFor(viewer)).map((entry) => entry.id)).not.toContain(doc.id)
    expect((await listFor(owner)).map((entry) => entry.id)).toContain(doc.id)
  })

  test("should exclude a doc when it or its host is archived", async () => {
    const archivedDoc = await createDoc((await createChannel("public")).id)
    await streamService.archiveStream(archivedDoc.id, wsId, owner)
    const archivedHost = await createChannel("public")
    const hostedDoc = await createDoc(archivedHost.id)
    await streamService.archiveStream(archivedHost.id, wsId, owner)

    const ids = (await listFor(owner)).map((entry) => entry.id)
    expect(ids).not.toContain(archivedDoc.id)
    expect(ids).not.toContain(hostedDoc.id)
  })

  test("should list a doc when the viewer reads it through a share grant", async () => {
    const doc = await createDoc((await createChannel("private")).id)
    const open = await createChannel("public")
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: open.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: doc.id, title: "Plan" } }] }],
      },
      contentMarkdown: "shared",
      confirmedPrivacyWarning: true,
    })

    expect((await listFor(viewer)).map((entry) => entry.id)).toContain(doc.id)
  })

  test("should report top-level placement for standalone docs and hosted placement for share-granted docs", async () => {
    const rootDoc = await streamService.create({ workspaceId: wsId, type: "doc", createdBy: owner })
    const hostedDoc = await createDoc((await createChannel("private")).id)
    const open = await createChannel("public")
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: open.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: hostedDoc.id, title: "Plan" } }] },
        ],
      },
      contentMarkdown: "shared",
      confirmedPrivacyWarning: true,
    })

    const ownerDocs = await listFor(owner)
    const viewerDocs = await listFor(viewer)
    expect(ownerDocs.find(({ id }) => id === rootDoc.id)?.isTopLevel).toBe(true)
    expect(viewerDocs.find(({ id }) => id === hostedDoc.id)?.isTopLevel).toBe(false)
  })
})
