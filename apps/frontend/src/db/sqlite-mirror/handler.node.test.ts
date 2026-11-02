import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createMirrorHandler } from "./handler"
import { encodeKey } from "./key-codec"
import type { MirrorReply, MirrorRequest } from "./protocol"
import { encodeValue } from "./value-codec"

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>
let db: Database

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:")
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
})

async function openHandler(options?: { txIdleMs?: number }) {
  const handler = createMirrorHandler(async () => ({ db, close: () => {}, destroy: async () => {} }), options)
  const send = (request: MirrorRequest) => handler.handle(request)
  await send({ type: "open", idbName: "test", schema: [{ name: "a", indexes: [] }], idbVersion: 1 })
  return send
}

const put = (tx: number, key: string, value: string): MirrorRequest => ({
  type: "write",
  tx,
  write: { store: "a", op: "put", entries: [{ key: encodeKey(key), value: encodeValue(value) }] },
})
const get = (key: string, tx?: number): MirrorRequest => ({ type: "get", store: "a", key: encodeKey(key), tx })
const failure = (reply: MirrorReply) => (reply.ok ? null : reply.error)

describe("mirror handler", () => {
  it("syncs every commit to disk, whatever the connection was set to before it opened", async () => {
    db.exec("PRAGMA synchronous=OFF")
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false })
    await send(put(1, "k", "v"))
    await send({ type: "commit", tx: 1 })
    expect(db.selectValue("PRAGMA synchronous")).toBe(2)
  })

  it("refuses every write and the commit of a transaction after a write failed", async () => {
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false })
    await send(put(1, "first", "v"))
    const failed = await send({
      type: "write",
      tx: 1,
      write: { store: "missing", op: "delete", keys: [encodeKey("k")] },
    })
    const afterFailure = await send(put(1, "third", "v"))
    const commit = await send({ type: "commit", tx: 1 })
    expect({
      failed: failed.ok,
      afterFailure: failure(afterFailure),
      commit: failure(commit),
      kept: [await send(get("first")), await send(get("third"))].map((reply) => reply.ok && reply.result),
      inTransaction: sqlite3.capi.sqlite3_get_autocommit(db.pointer!) === 0,
    }).toEqual({
      failed: false,
      afterFailure: "AbortError",
      commit: "AbortError",
      kept: [undefined, undefined],
      inTransaction: false,
    })
  })

  it("rolls back a transaction left without a request, failing it, so the next one runs", async () => {
    const send = await openHandler({ txIdleMs: 20 })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await send({ type: "begin", tx: 1, readonly: false })
    await send(put(1, "frozen", "v"))
    const next = await send({ type: "begin", tx: 2, readonly: false })
    await send(put(2, "next", "v"))
    await send({ type: "commit", tx: 2 })
    const frozenCommit = await send({ type: "commit", tx: 1 })
    expect({
      next: next.ok,
      frozenCommit: failure(frozenCommit),
      frozen: (await send(get("frozen"))).ok && (await send(get("frozen"))),
      warned: error.mock.calls.length,
    }).toMatchObject({ next: true, frozenCommit: "AbortError", frozen: { result: undefined }, warned: 1 })
    error.mockRestore()
  })

  it("holds a write outside any transaction until the readonly transactions reading meanwhile finish", async () => {
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false })
    await send(put(1, "k", "before"))
    await send({ type: "commit", tx: 1 })
    await send({ type: "begin", tx: 2, readonly: true })
    const first = await send(get("k", 2))
    let applied = false
    const apply = send({
      type: "apply",
      batch: [{ store: "a", op: "put", entries: [{ key: encodeKey("k"), value: encodeValue("after") }] }],
    }).then((reply) => {
      applied = true
      return reply
    })
    const second = await send(get("k", 2))
    const appliedBeforeCommit = applied
    await send({ type: "commit", tx: 2 })
    await apply
    expect({ first, second, appliedBeforeCommit, after: await send(get("k")) }).toMatchObject({
      first: { result: encodeValue("before") },
      second: { result: encodeValue("before") },
      appliedBeforeCommit: false,
      after: { result: encodeValue("after") },
    })
  })
})
