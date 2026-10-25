/**
 * DocRepository against the real schema (INV-68): head lock and seq bump, the
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
  test("allocates seqs under the head lock and refuses a stale bump", async () => {
    const ws = workspaceId()
    const doc = streamId()
    await DocRepository.insertHead(pool, { workspaceId: ws, streamId: doc })

    const bumped = await withTransaction(pool, async (client) => {
      const head = await DocRepository.findHeadForUpdate(client, ws, doc)
      return DocRepository.bumpHead(client, {
        workspaceId: ws,
        streamId: doc,
        seq: head!.updateSeq + 1,
        bodyMarkdown: "Hello",
        bodyJson: { type: "doc", content: [] },
        snapshotSeq: 1,
      })
    })
    const stale = await DocRepository.bumpHead(pool, {
      workspaceId: ws,
      streamId: doc,
      seq: 1,
      bodyMarkdown: "Stale",
      bodyJson: { type: "doc", content: [] },
    })

    expect({
      bumped: { updateSeq: bumped?.updateSeq, snapshotSeq: bumped?.snapshotSeq, bodyMarkdown: bumped?.bodyMarkdown },
      stale,
      otherWorkspace: await DocRepository.findHeadForUpdate(pool, workspaceId(), doc),
      head: (await DocRepository.findHead(pool, ws, doc))?.bodyMarkdown,
    }).toEqual({
      bumped: { updateSeq: 1, snapshotSeq: 1, bodyMarkdown: "Hello" },
      stale: null,
      otherWorkspace: null,
      head: "Hello",
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
