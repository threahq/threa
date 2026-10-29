import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import type { JSONContent, Stream } from "@threahq/types"
import {
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import { StreamRepository, StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  DynamicNamingDocTarget,
  DynamicNamingService,
  DynamicNamingStateRepository,
  type DynamicNamingDecision,
  type DynamicNamingEvaluationInput,
} from "../../src/features/dynamic-naming"
import { blockId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("doc-naming")
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
      name: "Doc Naming Workspace",
      slug: `doc-naming-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
async function createDocWithBody(paragraphs: string[], { topLevel = false } = {}): Promise<Stream> {
  const host = topLevel
    ? null
    : await streamService.createChannel({
        workspaceId: wsId,
        slug: `doc-naming-${++slugCounter}`,
        visibility: "public",
        createdBy: owner,
      })
  const doc = await streamService.create({
    workspaceId: wsId,
    type: "doc",
    parentStreamId: host?.id,
    createdBy: owner,
  })
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const blocks: JSONContent[] = paragraphs.map((text) => ({
    type: "paragraph",
    attrs: { blockId: blockId() },
    content: [{ type: "text", text }],
  }))
  const update = encodeUpdateBase64(writeContentJson(ydoc, { ...ydocToContentJson(ydoc), content: blocks }))
  await docService.postUpdate({ workspaceId: wsId, userId: owner, docId: doc.id, update })
  return doc
}

const body = ["Launch checklist for the lunar garden", "Seed order and soil", "Watering schedule"]

function buildService(
  decide: (input: DynamicNamingEvaluationInput) => Promise<DynamicNamingDecision>,
  now: () => Date = () => new Date(Date.now() + 10_000)
) {
  return new DynamicNamingService(
    pool,
    new Map([["doc", new DynamicNamingDocTarget(pool)]]),
    { decide },
    { schedule: async () => {} },
    now
  )
}

describe("doc dynamic naming", () => {
  test("should title an untitled doc from its body when the quiet window has passed", async () => {
    const doc = await createDocWithBody(body)
    const inputs: DynamicNamingEvaluationInput[] = []
    const service = buildService(async (input) => {
      inputs.push(input)
      return { action: "rename", title: "Lunar garden launch" }
    })

    const result = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: owner },
      "job_doc_rename"
    )
    const outbox = await pool.query(
      "SELECT payload->>'displayName' AS display_name FROM outbox WHERE event_type = 'stream:display_name_updated' AND payload->>'streamId' = $1",
      [doc.id]
    )

    expect({
      result,
      input: inputs[0],
      stream: await StreamRepository.findById(pool, wsId, doc.id),
      outbox: outbox.rows,
    }).toMatchObject({
      result: { status: "evaluated", action: "rename", revision: 1 },
      input: {
        targetKind: "doc",
        checkpoint: 3,
        forced: true,
        currentTitle: null,
        messageCount: 3,
        context: expect.stringContaining("Watering schedule"),
      },
      stream: { displayName: "Lunar garden launch", displayNameSource: "generated", displayNameRevision: 1 },
      outbox: [{ display_name: "Lunar garden launch" }],
    })
  })

  test("should leave a doc alone when a human named it", async () => {
    const doc = await createDocWithBody(body)
    await streamService.updateStream(
      doc.id,
      { displayName: "Launch plan" },
      { workspaceId: wsId, principal: { kind: "user", userId: owner } }
    )
    let calls = 0
    const service = buildService(async () => {
      calls += 1
      return { action: "rename", title: "Must not land" }
    })

    const result = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: owner },
      "job_doc_explicit"
    )
    expect({ result, calls }).toEqual({ result: { status: "protected" }, calls: 0 })
  })

  test("should requeue when the doc was edited inside the quiet window", async () => {
    const doc = await createDocWithBody(body)
    let calls = 0
    const service = buildService(
      async () => {
        calls += 1
        return { action: "rename", title: "Too early" }
      },
      () => new Date()
    )

    const result = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: owner },
      "job_doc_quiet"
    )
    expect({ status: result.status, calls }).toEqual({ status: "requeued", calls: 0 })
  })

  test("should not title a doc for a user who cannot write its host", async () => {
    const doc = await createDocWithBody(body)
    let calls = 0
    const service = buildService(async () => {
      calls += 1
      return { action: "rename", title: "Must not land" }
    })

    const result = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: outsider },
      "job_doc_outsider"
    )
    expect({ result, calls, stream: await StreamRepository.findById(pool, wsId, doc.id) }).toMatchObject({
      result: { status: "protected" },
      calls: 0,
      stream: { displayName: null, displayNameRevision: 0 },
    })
  })

  test("should hand an explicit doc title back to the namer when a member regenerates it", async () => {
    const doc = await createDocWithBody(body)
    await streamService.updateStream(
      doc.id,
      { displayName: "Launch plan" },
      { workspaceId: wsId, principal: { kind: "user", userId: owner } }
    )

    const result = await streamService.regenerateDisplayName(wsId, doc.id, { kind: "user", userId: owner })
    const requested = await pool.query(
      "SELECT payload FROM outbox WHERE event_type = 'dynamic_naming:requested' AND payload->>'targetId' = $1",
      [doc.id]
    )

    expect({
      result,
      state: await DynamicNamingStateRepository.find(pool, wsId, "doc", doc.id),
      requested: requested.rows.map((row) => row.payload),
    }).toMatchObject({
      result: { deferred: false, stream: { displayName: "Launch plan", displayNameSource: "generated" } },
      state: { targetKind: "doc", targetId: doc.id, regenerationPending: true },
      requested: [{ workspaceId: wsId, targetKind: "doc", targetId: doc.id, deferred: false, initiatingUserId: owner }],
    })
  })

  test("should title a top-level doc on its own authority, refusing a user who cannot write it", async () => {
    const doc = await createDocWithBody(body, { topLevel: true })
    const service = buildService(async () => ({ action: "rename", title: "Lunar garden launch" }))

    const outsiderResult = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: outsider },
      "job_doc_top_level_outsider"
    )
    const ownerResult = await service.evaluate(
      { workspaceId: wsId, targetKind: "doc", targetId: doc.id, initiatingUserId: owner },
      "job_doc_top_level"
    )

    expect({
      outsiderResult,
      ownerResult,
      stream: await StreamRepository.findById(pool, wsId, doc.id),
    }).toMatchObject({
      outsiderResult: { status: "protected" },
      ownerResult: { status: "evaluated", action: "rename", revision: 1 },
      stream: { parentStreamId: null, displayName: "Lunar garden launch", displayNameRevision: 1 },
    })
  })
})
