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
  const schema = ["a", "b"].map((name) => ({ name, indexes: [] }))
  await send({ type: "open", idbName: "test", schema, idbVersion: 1 })
  return send
}

const put = (tx: number, key: string, value: string, store = "a"): MirrorRequest => ({
  type: "write",
  tx,
  write: { store, op: "put", entries: [{ key: encodeKey(key), value: encodeValue(value) }] },
})
const get = (key: string, tx?: number, store = "a"): MirrorRequest => ({ type: "get", store, key: encodeKey(key), tx })
const failure = (reply: MirrorReply) => (reply.ok ? null : reply.error)

describe("mirror handler", () => {
  it("reports progress through an index rebuild, so a long open is not taken for a dead worker", async () => {
    const send = await openHandler()
    const entries = Array.from({ length: 2000 }, (_, n) => ({ key: encodeKey(n), value: encodeValue({ n }) }))
    await send({ type: "apply", batch: [{ store: "a", op: "put", entries }] })
    const reopened = createMirrorHandler(async () => ({ db, close: () => {}, destroy: async () => {} }))
    let reports = 0
    const schema = [{ name: "a", indexes: [{ name: "n", keyPath: "n", multiEntry: false }] }]
    await reopened.handle({ type: "open", idbName: "test", schema, idbVersion: 1 }, () => reports++)
    expect(reports).toBe(5)
  })

  it("answers whether a commit landed from its ledger row, and unknown once the row was pruned", async () => {
    const send = await openHandler()
    for (let tx = 1; tx <= 1002; tx++) {
      await send({ type: "begin", tx, readonly: false, stores: ["a"] })
      await send({ type: "commit", tx, ledger: { tab: "tab", tx } })
    }
    await send({ type: "begin", tx: 1003, readonly: false, stores: ["a"] })
    await send(put(1003, "k", "v"))
    await send({ type: "rollback", tx: 1003 })
    const committed = async (tab: string, tx: number) => {
      const reply = await send({ type: "committed", ledger: { tab, tx } })
      return reply.ok ? reply.committed : reply.error
    }
    expect({
      latest: await committed("tab", 1002),
      oldestKept: await committed("tab", 3),
      pruned: await committed("tab", 2),
      rolledBack: await committed("tab", 1003),
      otherTab: await committed("other", 2),
    }).toEqual({ latest: true, oldestKept: true, pruned: null, rolledBack: false, otherTab: false })
  })

  it("syncs every commit to disk, whatever the connection was set to before it opened", async () => {
    db.exec("PRAGMA synchronous=OFF")
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false, stores: ["a"] })
    await send(put(1, "k", "v"))
    await send({ type: "commit", tx: 1, ledger: { tab: "tab", tx: 1 } })
    expect(db.selectValue("PRAGMA synchronous")).toBe(2)
  })

  it("refuses every write and the commit of a transaction after a write failed", async () => {
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false, stores: ["a"] })
    await send(put(1, "first", "v"))
    const failed = await send({
      type: "write",
      tx: 1,
      write: { store: "missing", op: "delete", keys: [encodeKey("k")] },
    })
    const afterFailure = await send(put(1, "third", "v"))
    const commit = await send({ type: "commit", tx: 1, ledger: { tab: "tab", tx: 1 } })
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
    await send({ type: "begin", tx: 1, readonly: false, stores: ["a"] })
    await send(put(1, "frozen", "v"))
    const next = await send({ type: "begin", tx: 2, readonly: false, stores: ["a"] })
    await send(put(2, "next", "v"))
    await send({ type: "commit", tx: 2, ledger: { tab: "tab", tx: 2 } })
    const frozenCommit = await send({ type: "commit", tx: 1, ledger: { tab: "tab", tx: 1 } })
    expect({
      next: next.ok,
      frozenCommit: failure(frozenCommit),
      frozen: (await send(get("frozen"))).ok && (await send(get("frozen"))),
      warned: error.mock.calls.length,
    }).toMatchObject({ next: true, frozenCommit: "AbortError", frozen: { result: undefined }, warned: 1 })
    error.mockRestore()
  })

  it("runs a readonly transaction on other stores beside a readwrite one, and holds those that overlap it", async () => {
    const send = await openHandler()
    const settled: string[] = []
    const track = (name: string, reply: Promise<MirrorReply>) =>
      reply.then((value) => {
        settled.push(name)
        return value
      })
    await send({ type: "begin", tx: 1, readonly: false, stores: ["a"] })
    await send(put(1, "k", "written"))
    await send({ type: "begin", tx: 2, readonly: true, stores: ["b"] })
    const beside = await track("beside", send(get("k", 2, "b")))
    void send({ type: "begin", tx: 3, readonly: true, stores: ["a"] })
    const overlapping = track("overlapping", send(get("k", 3)))
    void send({ type: "begin", tx: 4, readonly: false, stores: ["b"] })
    const secondWriter = track("secondWriter", send(put(4, "k", "second", "b")))
    await send({ type: "commit", tx: 2, ledger: { tab: "tab", tx: 2 } })
    const beforeCommit = [...settled]
    await send({ type: "commit", tx: 1, ledger: { tab: "tab", tx: 1 } })
    expect({
      beside: beside.ok,
      beforeCommit,
      overlapping: await overlapping,
      secondWriter: (await secondWriter).ok,
    }).toEqual({
      beside: true,
      beforeCommit: ["beside"],
      overlapping: expect.objectContaining({ result: encodeValue("written") }),
      secondWriter: true,
    })
  })

  it("holds a write outside any transaction until the readonly transactions reading meanwhile finish", async () => {
    const send = await openHandler()
    await send({ type: "begin", tx: 1, readonly: false, stores: ["a"] })
    await send(put(1, "k", "before"))
    await send({ type: "commit", tx: 1, ledger: { tab: "tab", tx: 1 } })
    await send({ type: "begin", tx: 2, readonly: true, stores: ["a"] })
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
    await send({ type: "commit", tx: 2, ledger: { tab: "tab", tx: 2 } })
    await apply
    expect({ first, second, appliedBeforeCommit, after: await send(get("k")) }).toMatchObject({
      first: { result: encodeValue("before") },
      second: { result: encodeValue("before") },
      appliedBeforeCommit: false,
      after: { result: encodeValue("after") },
    })
  })
})
