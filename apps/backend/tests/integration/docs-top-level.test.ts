/**
 * Top-level docs against the real schema (INV-68): a doc with no host is its own root, like a channel. It
 * takes its own visibility and members, people join to edit, and a move lifts a hosted doc out or nests a
 * top-level doc under a host, its section threads re-rooting with it (INV-62).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import { DocErrorCodes, StreamErrorCodes, type JSONContent, type Stream } from "@threahq/types"
import {
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamService,
  listAccessibleStreamIds,
  type MoveDocParams,
} from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, botId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string
let alice: string
let bob: string
let guest: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-top-level")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    alice = (await addTestMember(client, wsId, userId())).id
    bob = (await addTestMember(client, wsId, userId())).id
    guest = (await addTestMember(client, wsId, userId(), "guest")).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Top-level Docs Test Workspace",
      slug: `docs-top-level-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createChannel(memberIds: string[]): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `docs-top-level-${++slugCounter}`,
    visibility: "private",
    createdBy: owner,
    memberIds,
  })
}

function createTopLevelDoc(visibility?: "public" | "private", createdBy = owner): Promise<Stream> {
  return streamService.create({ workspaceId: wsId, type: "doc", visibility, createdBy })
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

function createSectionThread(doc: Stream, block: string): Promise<Stream> {
  return streamService.createThread({
    workspaceId: wsId,
    parentStreamId: doc.id,
    parentAnchorId: block,
    createdBy: owner,
    principal: { kind: "user", userId: owner },
  })
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

async function memberIds(streamId: string) {
  return (await StreamMemberRepository.list(pool, wsId, { streamId })).map((member) => member.memberId).sort()
}

async function movedRows(hostId: string) {
  return (await StreamEventRepository.list(pool, wsId, hostId, { types: ["doc:moved"] })).map((event) => event.payload)
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

describe("top-level docs", () => {
  test("should create a private doc that only its creator can read, as its only member", async () => {
    const doc = await createTopLevelDoc()

    expect({
      doc: { parentStreamId: doc.parentStreamId, rootStreamId: doc.rootStreamId, visibility: doc.visibility },
      members: await memberIds(doc.id),
      readers: await readers([doc.id]),
    }).toEqual({
      doc: { parentStreamId: null, rootStreamId: null, visibility: "private" },
      members: [owner],
      readers: { [alice]: [], [bob]: [] },
    })
  })

  test("should let anyone read a public doc but edit it only after joining", async () => {
    const doc = await createTopLevelDoc("public")
    const before = await refusal(write(doc.id, bob, "Before joining"))

    await streamService.joinPublicChannel(doc.id, wsId, bob)
    await write(doc.id, bob, "After joining")

    expect({ readers: await readers([doc.id]), before, members: await memberIds(doc.id) }).toEqual({
      readers: { [alice]: [doc.id], [bob]: [doc.id] },
      before: { status: 403, code: StreamErrorCodes.READ_ONLY },
      members: [owner, bob].sort(),
    })
  })

  test("should refuse guests, bots and a visibility on a hosted doc", async () => {
    const host = await createChannel([])

    expect({
      guest: await refusal(createTopLevelDoc("private", guest)),
      bot: await refusal(streamService.createDoc({ workspaceId: wsId, principal: { kind: "bot", botId: botId() } })),
      hostedVisibility: await refusal(
        streamService.createDoc({
          workspaceId: wsId,
          parentStreamId: host.id,
          visibility: "public",
          principal: { kind: "user", userId: owner },
        })
      ),
    }).toEqual({
      guest: { status: 403, code: StreamErrorCodes.CHANNEL_MANAGEMENT_FORBIDDEN },
      bot: { status: 403, code: DocErrorCodes.TOP_LEVEL_REQUIRES_USER },
      hostedVisibility: { status: 400, code: DocErrorCodes.VISIBILITY_INHERITED },
    })
  })
})

describe("moving a doc to and from the top level", () => {
  test("should lift a hosted doc and its threads onto the doc itself, with the mover as its member", async () => {
    const host = await createChannel([alice])
    const doc = await streamService.create({
      workspaceId: wsId,
      type: "doc",
      parentStreamId: host.id,
      createdBy: owner,
    })
    const thread = await createSectionThread(doc, await write(doc.id, owner, "Plan"))
    const before = await readers([doc.id, thread.id])

    const moved = await move({ docId: doc.id, fromStreamId: host.id, toStreamId: null, visibility: "public" })

    const threadRow = await streamService.getStreamById(wsId, thread.id)
    expect({
      before,
      after: await readers([doc.id, thread.id]),
      doc: { parentStreamId: moved.parentStreamId, rootStreamId: moved.rootStreamId, visibility: moved.visibility },
      thread: { parentStreamId: threadRow?.parentStreamId, rootStreamId: threadRow?.rootStreamId },
      members: await memberIds(doc.id),
      inHost: await movedRows(host.id),
    }).toEqual({
      before: { [alice]: [doc.id, thread.id].sort(), [bob]: [] },
      after: { [alice]: [doc.id, thread.id].sort(), [bob]: [doc.id, thread.id].sort() },
      doc: { parentStreamId: null, rootStreamId: null, visibility: "public" },
      thread: { parentStreamId: doc.id, rootStreamId: doc.id },
      members: [owner],
      inHost: [{ docId: doc.id, fromStreamId: host.id, toStreamId: null }],
    })
  })

  test("should nest a top-level doc under a host and drop the members that no longer grant access", async () => {
    const host = await createChannel([bob])
    const doc = await createTopLevelDoc()
    await streamService.addMember(doc.id, alice, wsId, owner)
    const thread = await createSectionThread(doc, await write(doc.id, owner, "Plan"))

    const moved = await move({ docId: doc.id, fromStreamId: null, toStreamId: host.id })

    const threadRow = await streamService.getStreamById(wsId, thread.id)
    expect({
      readers: await readers([doc.id, thread.id]),
      doc: { parentStreamId: moved.parentStreamId, rootStreamId: moved.rootStreamId },
      thread: { parentStreamId: threadRow?.parentStreamId, rootStreamId: threadRow?.rootStreamId },
      members: await memberIds(doc.id),
      inHost: await movedRows(host.id),
    }).toEqual({
      readers: { [alice]: [], [bob]: [doc.id, thread.id].sort() },
      doc: { parentStreamId: host.id, rootStreamId: host.id },
      thread: { parentStreamId: doc.id, rootStreamId: host.id },
      members: [],
      inHost: [{ docId: doc.id, fromStreamId: null, toStreamId: host.id }],
    })
  })

  test("should refuse a stale top-level pin and a bot lifting a doc out", async () => {
    const host = await createChannel([])
    const doc = await streamService.create({
      workspaceId: wsId,
      type: "doc",
      parentStreamId: host.id,
      createdBy: owner,
    })

    expect({
      stale: await refusal(move({ docId: doc.id, fromStreamId: null, toStreamId: null })),
      bot: await refusal(move({ docId: doc.id, toStreamId: null, principal: { kind: "bot", botId: botId() } })),
    }).toEqual({
      stale: { status: 409, code: DocErrorCodes.MOVED_CONCURRENTLY },
      bot: { status: 403, code: DocErrorCodes.TOP_LEVEL_REQUIRES_USER },
    })
  })
})
