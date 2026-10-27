import { afterEach, describe, expect, it } from "vitest"
import { db, getActiveDb } from "@/db"
import { dexieDocLocalCopies } from "./doc-local-copy"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

function queued(id: string, docId: string, bytes: number[]) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    type: "doc_update" as const,
    payload: { docId, update: btoa(String.fromCharCode(...bytes)) },
    createdAt: Number(id.slice(-1)),
    retryCount: 0,
  }
}

describe("dexieDocLocalCopies", () => {
  afterEach(async () => {
    await db.docStates.clear()
    await db.pendingOperations.clear()
  })

  it("should read back the saved copy with its own and the queue's unsent edits for that doc", async () => {
    const copies = dexieDocLocalCopies(getActiveDb())
    await copies.write(WORKSPACE_ID, DOC_ID, { state: new Uint8Array([1]), seq: 4, unsent: new Uint8Array([2]) })
    await db.pendingOperations.bulkAdd([queued("op_1", DOC_ID, [3]), queued("op_2", "stream_other", [9])])

    const copy = await copies.read(WORKSPACE_ID, DOC_ID)

    // IndexedDB clones bytes into another realm's Uint8Array, so compare their contents.
    expect(copy && { ...copy, state: [...copy.state], unsent: copy.unsent.map((bytes) => [...bytes]) }).toEqual({
      state: [1],
      seq: 4,
      unsent: [[2], [3]],
      queuedIds: ["op_1"],
    })
  })

  it("should read nothing when the doc has no copy, even with queued edits", async () => {
    const copies = dexieDocLocalCopies(getActiveDb())
    await db.pendingOperations.add(queued("op_1", DOC_ID, [3]))

    expect(await copies.read(WORKSPACE_ID, DOC_ID)).toBeNull()
  })

  it("should remove the copy and only the named queue rows", async () => {
    const copies = dexieDocLocalCopies(getActiveDb())
    await copies.write(WORKSPACE_ID, DOC_ID, { state: new Uint8Array([1]), seq: 4, unsent: null })
    await db.pendingOperations.bulkAdd([queued("op_1", DOC_ID, [3]), queued("op_2", DOC_ID, [4])])

    await copies.remove(WORKSPACE_ID, DOC_ID, ["op_1"])

    expect({
      copy: await copies.read(WORKSPACE_ID, DOC_ID),
      queued: (await db.pendingOperations.toArray()).map((op) => op.id),
    }).toEqual({ copy: null, queued: ["op_2"] })
  })
})
