/**
 * DocRepository against the real schema (INV-68): head lock and advance, the
 * update log and snapshots as bytes, and section replacement as a set.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { DocRepository, type DocSection } from "../../src/features/docs"
import { streamId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("docs-repository")
  pool = db.pool
  cleanup = db.cleanup
})

afterAll(async () => {
  await cleanup()
})

const section = (blockId: string, position: number, markdown: string): DocSection => ({
  blockId,
  position,
  kind: "paragraph",
  markdown,
  contentJson: { type: "paragraph", attrs: { blockId }, content: [{ type: "text", text: markdown }] },
})

describe("DocRepository", () => {
  test("advances the head under its row lock, scoped to the workspace", async () => {
    const ws = workspaceId()
    const doc = streamId()
    await DocRepository.insertHead(pool, { workspaceId: ws, streamId: doc })
    const bodyJson = { type: "doc", content: [] }

    await withTransaction(pool, async (client) => {
      const head = await DocRepository.findHeadForUpdate(client, ws, doc)
      await DocRepository.bumpHead(client, {
        workspaceId: ws,
        streamId: doc,
        seq: head!.updateSeq + 1,
        bodyMarkdown: "Hello",
        bodyJson,
      })
    })
    await DocRepository.bumpHead(pool, {
      workspaceId: workspaceId(),
      streamId: doc,
      seq: 9,
      bodyMarkdown: "Other",
      bodyJson,
    })

    const head = await DocRepository.findHead(pool, ws, doc)
    expect({
      head: { updateSeq: head?.updateSeq, bodyMarkdown: head?.bodyMarkdown },
      otherWorkspace: await DocRepository.findHeadForUpdate(pool, workspaceId(), doc),
    }).toEqual({
      head: { updateSeq: 1, bodyMarkdown: "Hello" },
      otherWorkspace: null,
    })
  })

  test("stores updates and snapshots as bytes and lists updates after a seq", async () => {
    const ws = workspaceId()
    const doc = streamId()
    for (const seq of [1, 2, 3]) {
      await DocRepository.insertUpdate(pool, {
        workspaceId: ws,
        docId: doc,
        seq,
        update: new Uint8Array([seq, 0, 255]),
        actorId: "usr_1",
        actorType: "user",
      })
    }
    await DocRepository.insertSnapshot(pool, { workspaceId: ws, docId: doc, seq: 1, state: new Uint8Array([9]) })
    await DocRepository.insertSnapshot(pool, { workspaceId: ws, docId: doc, seq: 2, state: new Uint8Array([8, 7]) })

    const updates = await DocRepository.listUpdatesAfter(pool, ws, doc, 1)
    expect({
      updates: updates.map(({ seq, update, actorId, actorType }) => ({ seq, update: [...update], actorId, actorType })),
      snapshot: await DocRepository.findLatestSnapshot(pool, ws, doc),
    }).toEqual({
      updates: [
        { seq: 2, update: [2, 0, 255], actorId: "usr_1", actorType: "user" },
        { seq: 3, update: [3, 0, 255], actorId: "usr_1", actorType: "user" },
      ],
      snapshot: { seq: 2, state: new Uint8Array([8, 7]) },
    })
  })

  test("replaces sections with exactly the new set", async () => {
    const ws = workspaceId()
    const doc = streamId()
    await DocRepository.replaceSections(pool, ws, doc, [section("blk_a", 0, "A"), section("blk_b", 1, "B")])
    await DocRepository.replaceSections(pool, ws, doc, [section("blk_c", 0, "C"), section("blk_a", 1, "A2")])
    const afterReplace = await DocRepository.listSections(pool, ws, doc)
    await DocRepository.replaceSections(pool, ws, doc, [])

    expect({
      afterReplace,
      afterEmpty: await DocRepository.listSections(pool, ws, doc),
    }).toEqual({
      afterReplace: [section("blk_c", 0, "C"), section("blk_a", 1, "A2")],
      afterEmpty: [],
    })
  })
})
