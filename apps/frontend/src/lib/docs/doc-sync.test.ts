import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import {
  DOC_FRAGMENT,
  type DocState,
  type DocUpdatedPayload,
  type DocUpdateView,
  type JSONContent,
  type Stream,
} from "@threahq/types"
import { ApiError } from "@/api/client"
import * as operationQueueModule from "@/sync/operation-queue"
import type { DocLocalCopies, DocLocalCopy } from "./doc-local-copy"
import { DocSync, FLUSH_CAP_MS, LOCAL_COPY_SAVE_MS, REMOTE_ORIGIN } from "./doc-sync"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"
const LONGEST_BACKOFF_MS = 10_000

interface Hold {
  release: () => void
  fail: (error: unknown) => void
}

class FakeDocServer {
  readonly doc = new Y.Doc()
  readonly log: DocUpdateView[] = []
  pageSize = Infinity
  readonly clients = new Set<DocSync>()
  private readonly postErrors: ApiError[] = []

  readonly api = {
    get: vi.fn(
      async (_ws: string, _doc: string, stateVector?: string): Promise<DocState> => ({
        stream: { id: DOC_ID } as Stream,
        seq: this.seq,
        state: bytesToBase64(
          Y.encodeStateAsUpdate(this.doc, stateVector === undefined ? undefined : base64ToBytes(stateVector))
        ),
        sections: [],
      })
    ),
    listUpdates: vi.fn(async (_ws: string, _doc: string, after: number) => {
      const rows = this.log.filter((entry) => entry.seq > after)
      return { updates: rows.slice(0, this.pageSize), hasMore: rows.length > this.pageSize }
    }),
    postUpdate: vi.fn(async (_ws: string, _doc: string, update: string) => {
      const error = this.postErrors.shift()
      if (error) throw error
      // As the server does: bytes whose dependencies it lacks are refused.
      const trial = new Y.Doc()
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(this.doc))
      Y.applyUpdate(trial, base64ToBytes(update))
      if (trial.store.pendingStructs || trial.store.pendingDs) {
        throw new ApiError(400, "UPDATE_NOT_APPLICABLE", "UPDATE_NOT_APPLICABLE")
      }
      const seq = this.store(update)
      if (seq === null) return { seq: this.seq, applied: false, touchedBlockIds: [] }
      this.broadcast(seq)
      return { seq, applied: true, touchedBlockIds: [] }
    }),
  }

  get seq(): number {
    return this.log.at(-1)?.seq ?? 0
  }

  get text(): string {
    return this.doc.getText("t").toString()
  }

  failNextPost(status: number, code: string): void {
    this.postErrors.push(new ApiError(status, code, code))
  }

  /** The next POST waits until released (then stores) or failed. */
  holdNextPost(): Hold {
    const real = this.api.postUpdate.getMockImplementation()!
    const hold = deferred()
    this.api.postUpdate.mockImplementationOnce(async (...args) => {
      await hold.promise
      return real(...args)
    })
    return hold
  }

  /** The next listUpdates reads the log at once but answers only when released. */
  holdNextListUpdates(): Hold {
    const real = this.api.listUpdates.getMockImplementation()!
    const hold = deferred()
    this.api.listUpdates.mockImplementationOnce(async (...args) => {
      const result = await real(...args)
      await hold.promise
      return result
    })
    return hold
  }

  /** Another writer's edit, stored but not broadcast; returns its payload for delivery by hand. */
  writeElsewhere(text: string): DocUpdatedPayload {
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(this.doc))
    const before = Y.encodeStateVector(other)
    other.getText("t").insert(other.getText("t").length, text)
    const seq = this.store(bytesToBase64(Y.encodeStateAsUpdate(other, before)))!
    return this.payload(seq)
  }

  /** An agent's rewrite as the server writes it: `staging` first forces fresh elements, as a move does. */
  writeContent(json: JSONContent, staging?: JSONContent): DocUpdatedPayload {
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(this.doc))
    const before = Y.encodeStateVector(other)
    other.transact(() => {
      if (staging) writeDoc(other, staging)
      writeDoc(other, json)
    })
    const seq = this.store(bytesToBase64(Y.encodeStateAsUpdate(other, before)))!
    return this.payload(seq)
  }

  broadcast(seq: number): void {
    for (const client of this.clients) client.receive(this.payload(seq))
  }

  /** Stores and logs the update; `null` when the doc already held every byte of it. */
  private store(update: string): number | null {
    const before = Y.snapshot(this.doc)
    Y.applyUpdate(this.doc, base64ToBytes(update))
    if (Y.equalSnapshots(before, Y.snapshot(this.doc))) return null
    const seq = this.seq + 1
    this.log.push({ seq, update, actorId: "usr_1", actorType: "user" })
    return seq
  }

  private payload(seq: number): DocUpdatedPayload {
    const entry = this.log.find((candidate) => candidate.seq === seq)!
    return {
      workspaceId: WORKSPACE_ID,
      streamId: DOC_ID,
      seq,
      update: entry.update,
      touchedBlockIds: [],
      actorId: entry.actorId,
      actorType: entry.actorType,
    }
  }
}

function writeDoc(ydoc: Y.Doc, json: JSONContent): void {
  const node = getThreaSchema().nodeFromJSON(json)
  updateYFragment(ydoc, ydoc.getXmlFragment(DOC_FRAGMENT), node, { mapping: new Map(), isOMark: new Map() })
}

function deferred(): Hold & { promise: Promise<void> } {
  let release!: () => void
  let fail!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}

/** What reached the operation queue, as the text each self-contained update produces. */
let enqueued: { docId: string; text: string }[] = []

/** This device's store, shared by every client a test connects; `queued` stands in for the queue's rows for the doc. */
class MemoryLocalCopies implements DocLocalCopies {
  copy: Omit<DocLocalCopy, "queuedIds"> | null = null
  queued: { id: string; update: Uint8Array }[] = []

  read = vi.fn(async (): Promise<DocLocalCopy | null> => {
    if (!this.copy) return null
    return {
      ...this.copy,
      unsent: [...this.copy.unsent, ...this.queued.map((row) => row.update)],
      queuedIds: this.queued.map((row) => row.id),
    }
  })
  write = vi.fn(
    async (_ws: string, _doc: string, copy: { state: Uint8Array; seq: number; unsent: Uint8Array | null }) => {
      this.copy = { state: copy.state, seq: copy.seq, unsent: copy.unsent ? [copy.unsent] : [] }
    }
  )
  remove = vi.fn(async (_ws: string, _doc: string, queuedIds: string[] = []) => {
    this.copy = null
    this.queued = this.queued.filter((row) => !queuedIds.includes(row.id))
  })

  get text(): string | null {
    if (!this.copy) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.mergeUpdates([this.copy.state, ...this.copy.unsent]))
    return doc.getText("t").toString()
  }
}

let localCopies: MemoryLocalCopies

function connect(server: FakeDocServer) {
  const ydoc = new Y.Doc()
  const rejections: string[] = []
  const lost: unknown[] = []
  const kicks: string[] = []
  const sync = new DocSync({
    workspaceId: WORKSPACE_ID,
    docId: DOC_ID,
    ydoc,
    api: server.api,
    localCopies,
    onRejected: (refusal) => rejections.push(refusal.code),
    onLost: (error) => lost.push(error),
    kickOperationQueue: () => kicks.push(`after ${enqueued.length}`),
  })
  server.clients.add(sync)
  return { ydoc, sync, rejections, lost, enqueued, kicks, text: () => ydoc.getText("t").toString() }
}

function type(ydoc: Y.Doc, text: string): void {
  const ytext = ydoc.getText("t")
  ytext.insert(ytext.length, text)
}

/** The text a self-contained update produces on an empty doc. */
function textOf(update: string): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, base64ToBytes(update))
  return doc.getText("t").toString()
}

function postedTexts(server: FakeDocServer): string[] {
  return server.api.postUpdate.mock.calls.map((call) => textOf(call[2]))
}

const blockIds = {
  a: "blk_0000000000000000000000000A",
  b: "blk_0000000000000000000000000B",
  c: "blk_0000000000000000000000000C",
}

function block(id: string, text: string, type = "paragraph", marks?: JSONContent["marks"]): JSONContent {
  return {
    type,
    attrs: { blockId: id, ...(type === "heading" ? { level: 2 } : {}) },
    content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
  }
}

function doc(...blocks: JSONContent[]): JSONContent {
  return { type: "doc", content: blocks }
}

const alpha = block(blockIds.a, "alpha")
const beta = block(blockIds.b, "beta")
const gamma = block(blockIds.c, "gamma")

/** Each top-level block as `type: text`, the shape a reader sees. */
function blocksOf(ydoc: Y.Doc): string[] {
  const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_FRAGMENT)) as JSONContent
  return (json.content ?? []).map(
    (node) => `${node.type}: ${(node.content ?? []).map((child) => child.text ?? "").join("")}`
  )
}

/** Web Locks as one browser grants them to its tabs: shared or exclusive, queued in order, `ifAvailable`, abortable. */
class FakeLocks {
  private readonly held = new Map<string, { exclusive: boolean; count: number }>()
  private readonly waiting = new Map<string, (() => boolean)[]>()

  request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown): Promise<unknown> {
    const exclusive = options.mode !== "shared"
    const free = () => {
      const lock = this.held.get(name)
      return !lock || (!exclusive && !lock.exclusive)
    }
    const run = () => {
      const lock = this.held.get(name) ?? { exclusive, count: 0 }
      lock.count += 1
      this.held.set(name, lock)
      return Promise.resolve(callback({ name, mode: exclusive ? "exclusive" : "shared" })).finally(() => {
        lock.count -= 1
        if (lock.count === 0) this.held.delete(name)
        const queue = this.waiting.get(name) ?? []
        while (queue.length > 0 && queue[0]()) queue.shift()
      })
    }
    if (free() && !this.waiting.get(name)?.length) return run()
    if (options.ifAvailable) return Promise.resolve(callback(null))
    return new Promise((resolve, reject) => {
      const grant = () => {
        if (!free()) return false
        run().then(resolve, reject)
        return true
      }
      const queue = this.waiting.get(name) ?? []
      queue.push(grant)
      this.waiting.set(name, queue)
      options.signal?.addEventListener("abort", () => {
        const index = queue.indexOf(grant)
        if (index === -1) return
        queue.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      })
    })
  }
}

describe("DocSync", () => {
  let server: FakeDocServer

  beforeEach(() => {
    vi.useFakeTimers()
    server = new FakeDocServer()
    enqueued = []
    localCopies = new MemoryLocalCopies()
    vi.spyOn(operationQueueModule, "enqueueDocUpdate").mockImplementation(async (_ws, docId, update) => {
      enqueued.push({ docId, text: textOf(update) })
    })
  })

  afterEach(() => {
    for (const client of server.clients) client.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("applies the loaded state as a remote update and becomes ready", async () => {
    server.writeElsewhere("hello")
    const client = connect(server)
    const origins: unknown[] = []
    client.ydoc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin))

    await client.sync.start()

    expect({ text: client.text(), status: client.sync.getStatus(), origins }).toEqual({
      text: "hello",
      status: { phase: "ready" },
      origins: [REMOTE_ORIGIN],
    })
  })

  it("should post at once when a space ends a word", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "hi ")
    await vi.advanceTimersByTimeAsync(0)

    expect({ posted: postedTexts(server), serverText: server.text }).toEqual({ posted: ["hi "], serverText: "hi " })
  })

  it("should hold letters until the cap after the first change when no boundary is typed", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "a")
    await vi.advanceTimersByTimeAsync(1000)
    type(client.ydoc, "b")
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS - 1000 - 1)
    expect(server.api.postUpdate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    // Lets the local-copy save run; a leftover cap timer would still be pending.
    await vi.advanceTimersByTimeAsync(LOCAL_COPY_SAVE_MS)

    expect({ posted: postedTexts(server), serverText: server.text, timers: vi.getTimerCount() }).toEqual({
      posted: ["ab"],
      serverText: "ab",
      timers: 0,
    })
  })

  it.each<[string, (ydoc: Y.Doc) => void]>([
    ["a block is inserted", (ydoc) => ydoc.getXmlFragment("f").insert(0, [new Y.XmlElement("paragraph")])],
    ["text is formatted", (ydoc) => ydoc.getText("t").format(0, 2, { bold: true })],
    ["text is deleted", (ydoc) => ydoc.getText("t").delete(0, 1)],
  ])("should post at once when %s", async (_label, edit) => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "ab")
    edit(client.ydoc)
    await vi.advanceTimersByTimeAsync(0)

    expect(Y.encodeStateAsUpdate(server.doc)).toEqual(Y.encodeStateAsUpdate(client.ydoc))
  })

  it("applies the next remote update in order without fetching", async () => {
    const client = connect(server)
    await client.sync.start()

    client.sync.receive(server.writeElsewhere("one"))
    client.sync.receive(server.writeElsewhere(" two"))

    expect({ text: client.text(), fetched: server.api.listUpdates.mock.calls.length }).toEqual({
      text: "one two",
      fetched: 0,
    })
  })

  it("catches up from the known seq when a remote update skips one", async () => {
    server.writeElsewhere("base")
    const client = connect(server)
    await client.sync.start()

    server.writeElsewhere(" missed")
    client.sync.receive(server.writeElsewhere(" latest"))
    await vi.advanceTimersByTimeAsync(0)

    expect({ text: client.text(), afters: server.api.listUpdates.mock.calls.map((call) => call[2]) }).toEqual({
      text: "base missed latest",
      afters: [1],
    })
  })

  it("should replay the log a page at a time and take the next broadcast at once when it is longer than a page", async () => {
    const client = connect(server)
    await client.sync.start()
    server.pageSize = 1

    server.writeElsewhere("paged")
    server.writeElsewhere(" in")
    await client.sync.catchUp()
    client.sync.receive(server.writeElsewhere(" order"))

    expect({ text: client.text(), afters: server.api.listUpdates.mock.calls.map((call) => call[2]) }).toEqual({
      text: "paged in order",
      afters: [0, 1],
    })
  })

  it.each(["DOC_UPDATE_INVALID", "DOC_UPDATE_NOT_APPLICABLE"])(
    "drops an update refused with %s, reloads, and reports the rejection",
    async (code) => {
      const client = connect(server)
      await client.sync.start()
      server.failNextPost(400, code)

      type(client.ydoc, "bad")
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      await client.sync.flush()
      client.sync.stop()

      expect({
        posts: server.api.postUpdate.mock.calls.length,
        gets: server.api.get.mock.calls.length,
        status: client.sync.getStatus(),
        rejections: client.rejections,
        enqueued: client.enqueued,
      }).toEqual({ posts: 1, gets: 2, status: { phase: "ready" }, rejections: [code], enqueued: [] })
    }
  )

  it.each([
    ["a network error", new TypeError("Failed to fetch")],
    ["a 503", new ApiError(503, "UNAVAILABLE", "unavailable")],
  ])(
    "should queue the unacked edits once and resend them with newer ones when a post fails with %s",
    async (_label, error) => {
      const client = connect(server)
      await client.sync.start()
      server.api.postUpdate.mockRejectedValueOnce(error)

      type(client.ydoc, "kept")
      type(client.ydoc, " ")
      await vi.advanceTimersByTimeAsync(LONGEST_BACKOFF_MS)
      type(client.ydoc, "more ")
      await vi.advanceTimersByTimeAsync(0)

      expect({
        enqueued: client.enqueued,
        kicks: client.kicks,
        posted: postedTexts(server),
        server: Y.encodeStateAsUpdate(server.doc),
      }).toEqual({
        enqueued: [{ docId: DOC_ID, text: "kept " }],
        kicks: ["after 1"],
        posted: ["kept ", "kept more "],
        server: Y.encodeStateAsUpdate(client.ydoc),
      })
    }
  )

  it("should queue instead of posting when the browser is offline at flush time", async () => {
    const client = connect(server)
    await client.sync.start()
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)

    type(client.ydoc, "offline ")
    await vi.advanceTimersByTimeAsync(0)
    online.mockRestore()

    expect({ posts: server.api.postUpdate.mock.calls.length, enqueued: client.enqueued, kicks: client.kicks }).toEqual({
      posts: 0,
      enqueued: [{ docId: DOC_ID, text: "offline " }],
      kicks: [],
    })
  })

  it("should queue a word typed while an offline hand-off is still being stored", async () => {
    const client = connect(server)
    await client.sync.start()
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    let release!: () => void
    const stored = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(operationQueueModule.enqueueDocUpdate).mockImplementationOnce(async (_ws, docId, update) => {
      await stored
      enqueued.push({ docId, text: textOf(update) })
    })

    type(client.ydoc, "first ")
    await vi.advanceTimersByTimeAsync(0)
    type(client.ydoc, "second ")
    release()
    await vi.advanceTimersByTimeAsync(0)
    online.mockRestore()

    expect({ posts: server.api.postUpdate.mock.calls.length, enqueued: client.enqueued }).toEqual({
      posts: 0,
      enqueued: [
        { docId: DOC_ID, text: "first " },
        { docId: DOC_ID, text: "first second " },
      ],
    })
  })

  it("should keep a live sync's edits for the next flush when the queue cannot store them", async () => {
    const client = connect(server)
    await client.sync.start()
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    vi.mocked(operationQueueModule.enqueueDocUpdate).mockRejectedValueOnce(new Error("QuotaExceededError"))

    type(client.ydoc, "kept ")
    await vi.advanceTimersByTimeAsync(0)
    online.mockRestore()
    await client.sync.flush()

    expect({ lost: client.lost, server: server.text }).toEqual({ lost: [], server: "kept " })
  })

  it("should keep its seq when a re-sent edit the server already held answers with a peer's head", async () => {
    const client = connect(server)
    await client.sync.start()
    server.failNextPost(503, "UNAVAILABLE")
    type(client.ydoc, "kept ")
    await vi.advanceTimersByTimeAsync(0)
    // The queue delivers the handed-off bytes; the server echoes them back as seq 1.
    await server.api.postUpdate(WORKSPACE_ID, DOC_ID, bytesToBase64(Y.encodeStateAsUpdate(client.ydoc)))
    server.writeElsewhere("theirs ")

    await client.sync.flush()
    client.sync.receive(server.writeElsewhere("later"))
    await vi.advanceTimersByTimeAsync(0)

    expect({ text: client.text(), seqs: server.log.map((entry) => entry.seq) }).toEqual({
      text: "kept theirs later",
      seqs: [1, 2, 3],
    })
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "never loses a flush requested %i microtasks after another finishes",
    async (hops) => {
      const client = connect(server)
      await client.sync.start()
      const post = server.holdNextPost()

      type(client.ydoc, "a ")
      const running = client.sync.flush()
      post.release()
      for (let i = 0; i < hops; i++) await Promise.resolve()
      type(client.ydoc, "b")
      const again = client.sync.flush()
      await running
      await again
      await vi.advanceTimersByTimeAsync(0)

      expect(server.text).toBe("a b")
    }
  )

  it("should report the edits as lost when the queue cannot take them either", async () => {
    const client = connect(server)
    await client.sync.start()
    const quota = new Error("QuotaExceededError")
    vi.mocked(operationQueueModule.enqueueDocUpdate).mockRejectedValueOnce(quota)

    type(client.ydoc, "gone")
    client.sync.stop()
    await vi.advanceTimersByTimeAsync(0)

    expect({ lost: client.lost, kicks: client.kicks }).toEqual({ lost: [quota], kicks: [] })
  })

  it("should hand unsent edits to the queue when asked before the page unloads", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "unsent")
    client.sync.queueUnsent()
    await vi.advanceTimersByTimeAsync(0)

    expect({ enqueued: client.enqueued, posts: server.api.postUpdate.mock.calls.length }).toEqual({
      enqueued: [{ docId: DOC_ID, text: "unsent" }],
      posts: 0,
    })
  })

  it("converges two clients editing the same doc", async () => {
    const alice = connect(server)
    const bob = connect(server)
    await alice.sync.start()
    await bob.sync.start()

    type(alice.ydoc, "Rotation tracker")
    type(bob.ydoc, "Second paragraph")
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
    type(bob.ydoc, "!")
    await vi.advanceTimersByTimeAsync(0)

    expect({
      alice: Y.encodeStateAsUpdate(alice.ydoc),
      bob: Y.encodeStateAsUpdate(bob.ydoc),
      server: Y.encodeStateAsUpdate(server.doc),
      seq: server.seq,
      text: alice.text(),
    }).toEqual({
      alice: Y.encodeStateAsUpdate(server.doc),
      bob: Y.encodeStateAsUpdate(server.doc),
      server: Y.encodeStateAsUpdate(server.doc),
      seq: 3,
      text: expect.stringMatching(/^(Rotation trackerSecond paragraph|Second paragraphRotation tracker)!$/),
    })
  })

  it("should drop only the carried edits when a post acks after a mid-flight edit", async () => {
    const client = connect(server)
    await client.sync.start()
    const local: Uint8Array[] = []
    client.ydoc.on("update", (update: Uint8Array) => local.push(update))
    const post = server.holdNextPost()

    type(client.ydoc, "a ")
    await vi.advanceTimersByTimeAsync(0)
    type(client.ydoc, "b ")
    await vi.advanceTimersByTimeAsync(0)
    expect(server.api.postUpdate).toHaveBeenCalledTimes(1)
    post.release()
    await vi.advanceTimersByTimeAsync(0)

    expect({
      posted: server.api.postUpdate.mock.calls.map((call) => call[2]),
      serverText: server.text,
      status: client.sync.getStatus(),
    }).toEqual({
      posted: [bytesToBase64(Y.mergeUpdates([local[0]!])), bytesToBase64(Y.mergeUpdates([local[1]!]))],
      serverText: "a b ",
      status: { phase: "ready" },
    })
  })

  it("should apply the server's follow-up row when its own row's broadcast arrives before the post answers", async () => {
    const client = connect(server)
    await client.sync.start()
    const real = server.api.postUpdate.getMockImplementation()!
    let stamp: DocUpdatedPayload | null = null
    server.api.postUpdate.mockImplementationOnce(async (...args) => {
      const own = await real(...args)
      stamp = server.writeElsewhere(" [stamped]")
      return { ...own, seq: stamp.seq }
    })

    type(client.ydoc, "mine ")
    await vi.advanceTimersByTimeAsync(0)
    client.sync.receive(stamp!)
    await vi.advanceTimersByTimeAsync(0)

    expect({ text: client.text(), status: client.sync.getStatus() }).toEqual({
      text: "mine  [stamped]",
      status: { phase: "ready" },
    })
  })

  it("keeps its seq when its own echo lands before the post result", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "mine")
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
    client.sync.receive(server.writeElsewhere(" theirs"))

    expect({ text: client.text(), fetched: server.api.listUpdates.mock.calls.length }).toEqual({
      text: "mine theirs",
      fetched: 0,
    })
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "never loses a catch-up requested %i microtasks after another finishes",
    async (hops) => {
      const client = connect(server)
      await client.sync.start()
      server.writeElsewhere("first")
      const list = server.holdNextListUpdates()

      const running = client.sync.catchUp()
      await vi.advanceTimersByTimeAsync(0)
      server.writeElsewhere(" late")
      list.release()
      for (let i = 0; i < hops; i++) await Promise.resolve()
      const again = client.sync.catchUp()
      await running
      await again
      await vi.advanceTimersByTimeAsync(0)

      expect(client.text()).toBe("first late")
    }
  )

  it("should queue the unacked edits and send nothing more when stopped mid-post", async () => {
    const client = connect(server)
    await client.sync.start()
    const post = server.holdNextPost()

    type(client.ydoc, "x ")
    await vi.advanceTimersByTimeAsync(0)
    type(client.ydoc, "y")
    client.sync.stop()
    post.fail(new TypeError("Failed to fetch"))
    await vi.advanceTimersByTimeAsync(0)

    expect({
      timers: vi.getTimerCount(),
      posts: server.api.postUpdate.mock.calls.length,
      enqueued: client.enqueued,
      kicks: client.kicks,
    }).toEqual({ timers: 0, posts: 1, enqueued: [{ docId: DOC_ID, text: "x y" }], kicks: ["after 1"] })
  })

  it("should queue the unacked edits without posting when stopped", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "last words")
    client.sync.stop()
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      enqueued: client.enqueued,
      kicks: client.kicks,
      timers: vi.getTimerCount(),
    }).toEqual({ posts: 0, enqueued: [{ docId: DOC_ID, text: "last words" }], kicks: ["after 1"], timers: 0 })
  })

  it("should queue nothing when stopped with every edit acked", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "saved ")
    await vi.advanceTimersByTimeAsync(0)
    client.sync.stop()

    expect({ posted: postedTexts(server), enqueued: client.enqueued }).toEqual({ posted: ["saved "], enqueued: [] })
  })

  it("stops catching up and reports an error when access to the doc is gone", async () => {
    const client = connect(server)
    await client.sync.start()
    const forbidden = new ApiError(403, "FORBIDDEN", "no access")
    server.api.listUpdates.mockRejectedValue(forbidden)

    await client.sync.catchUp()
    await vi.advanceTimersByTimeAsync(LONGEST_BACKOFF_MS * 3)

    expect({
      status: client.sync.getStatus(),
      fetched: server.api.listUpdates.mock.calls.length,
      timers: vi.getTimerCount(),
    }).toEqual({ status: { phase: "error", error: forbidden }, fetched: 1, timers: 0 })
  })

  it("ignores doc:updated payloads from another workspace or doc", async () => {
    const client = connect(server)
    await client.sync.start()
    const payload = server.writeElsewhere("theirs")

    client.sync.receive({ ...payload, workspaceId: "ws_other" })
    client.sync.receive({ ...payload, streamId: "stream_other" })

    expect({ text: client.text(), fetched: server.api.listUpdates.mock.calls.length }).toEqual({
      text: "",
      fetched: 0,
    })
  })

  it("should send the server doc's state vector when it reloads after a refusal", async () => {
    server.writeElsewhere("base")
    const client = connect(server)
    await client.sync.start()
    const stateVector = bytesToBase64(Y.encodeStateVector(client.ydoc))
    server.failNextPost(400, "DOC_UPDATE_INVALID")

    type(client.ydoc, "bad")
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
    await client.sync.flush()

    expect(server.api.get.mock.calls.map((call) => call[2])).toEqual([undefined, stateVector])
  })

  it("notifies subscribers only when the status changes", async () => {
    const client = connect(server)
    const seen: unknown[] = [client.sync.getStatus()]
    client.sync.subscribe(() => seen.push(client.sync.getStatus()))

    await client.sync.start()
    await client.sync.catchUp()
    type(client.ydoc, "x")
    type(client.ydoc, "y")
    await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)

    expect(seen).toEqual([{ phase: "loading" }, { phase: "ready" }])
  })

  describe("local copy", () => {
    const offline = new TypeError("Failed to fetch")

    /** Opens, types, and closes the doc, leaving its local copy behind. */
    async function closeAfterTyping(text: string, options: { online: boolean }) {
      const client = connect(server)
      await client.sync.start()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(options.online)
      type(client.ydoc, text)
      await vi.advanceTimersByTimeAsync(0)
      client.sync.stop()
      await vi.advanceTimersByTimeAsync(0)
      online.mockRestore()
      server.clients.delete(client.sync)
    }

    it("should open from the local copy when the server cannot be reached", async () => {
      await closeAfterTyping("saved ", { online: true })
      server.api.get.mockRejectedValue(offline)

      const client = connect(server)
      await client.sync.start()

      expect({ text: client.text(), status: client.sync.getStatus() }).toEqual({
        text: "saved ",
        status: { phase: "ready" },
      })
    })

    it("should send edits typed offline before and after reopening once back online", async () => {
      await closeAfterTyping("before ", { online: false })
      server.api.get.mockRejectedValue(offline)
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      const client = connect(server)
      await client.sync.start()
      type(client.ydoc, "after ")
      await vi.advanceTimersByTimeAsync(0)
      online.mockRestore()

      await client.sync.flush()

      expect({ text: client.text(), server: server.text }).toEqual({ text: "before after ", server: "before after " })
    })

    it("should fill in what the server gained since the copy was saved", async () => {
      await closeAfterTyping("mine ", { online: true })
      server.writeElsewhere("theirs")

      const client = connect(server)
      await client.sync.start()
      client.sync.receive(server.writeElsewhere(" later"))

      expect({ text: client.text(), after: server.api.listUpdates.mock.calls.map((call) => call[2]) }).toEqual({
        text: "mine theirs later",
        after: [1],
      })
    })

    it("should replay row by row when the copy is more than a page behind", async () => {
      await closeAfterTyping("mine ", { online: true })
      server.writeElsewhere("theirs")
      server.writeElsewhere(" again")
      server.pageSize = 1

      const client = connect(server)
      await client.sync.start()

      expect({ text: client.text(), after: server.api.listUpdates.mock.calls.map((call) => call[2]) }).toEqual({
        text: "mine theirs again",
        after: [1, 2],
      })
    })

    it("should save the doc as it changes", async () => {
      const client = connect(server)
      await client.sync.start()

      client.sync.receive(server.writeElsewhere("theirs "))
      type(client.ydoc, "mine")
      await vi.advanceTimersByTimeAsync(LOCAL_COPY_SAVE_MS)

      expect(localCopies.text).toBe("theirs mine")
    })

    it("should remove the local copy and show the error when the doc is gone", async () => {
      await closeAfterTyping("saved ", { online: true })
      const gone = new ApiError(404, "STREAM_NOT_FOUND", "gone")
      server.api.listUpdates.mockRejectedValue(gone)

      const client = connect(server)
      await client.sync.start()
      client.sync.stop()

      expect({ status: client.sync.getStatus(), copy: localCopies.copy }).toEqual({
        status: { phase: "error", error: gone },
        copy: null,
      })
    })

    it("should remove the local copy and stop saving it when the server refuses its edits", async () => {
      await closeAfterTyping("saved ", { online: true })
      const client = connect(server)
      await client.sync.start()
      server.failNextPost(403, "FORBIDDEN")

      type(client.ydoc, "refused ")
      await vi.advanceTimersByTimeAsync(LOCAL_COPY_SAVE_MS)
      client.sync.stop()

      expect({ rejections: client.rejections, copy: localCopies.copy }).toEqual({
        rejections: ["FORBIDDEN"],
        copy: null,
      })
    })

    it("should restore queued edits saved after the copy and send them with what is typed next", async () => {
      await closeAfterTyping("copied ", { online: true })
      const queuedDoc = new Y.Doc()
      Y.applyUpdate(queuedDoc, localCopies.copy!.state)
      const before = Y.encodeStateVector(queuedDoc)
      type(queuedDoc, "queued ")
      localCopies.queued = [{ id: "op_1", update: Y.encodeStateAsUpdate(queuedDoc, before) }]

      const client = connect(server)
      await client.sync.start()
      type(client.ydoc, "next ")
      await vi.advanceTimersByTimeAsync(0)

      expect({ text: client.text(), server: server.text }).toEqual({
        text: "copied queued next ",
        server: "copied queued next ",
      })
    })

    it("should delete the restored queue rows with the copy when the server refuses the edits", async () => {
      await closeAfterTyping("copied ", { online: true })
      localCopies.queued = [{ id: "op_1", update: new Uint8Array([0, 0]) }]
      const client = connect(server)
      await client.sync.start()
      server.failNextPost(403, "FORBIDDEN")

      type(client.ydoc, "refused ")
      await vi.advanceTimersByTimeAsync(0)

      expect({ copy: localCopies.copy, queued: localCopies.queued }).toEqual({ copy: null, queued: [] })
    })

    it("should keep edits and the copy when the session has expired, and send them once signed in", async () => {
      await closeAfterTyping("copied ", { online: true })
      const client = connect(server)
      await client.sync.start()
      server.failNextPost(401, "UNAUTHORIZED")
      type(client.ydoc, "kept ")
      await vi.advanceTimersByTimeAsync(0)
      client.sync.stop()
      server.clients.delete(client.sync)

      const reopened = connect(server)
      await reopened.sync.start()
      await reopened.sync.flush()

      expect({ rejections: client.rejections, server: server.text }).toEqual({ rejections: [], server: "copied kept " })
    })

    it("should catch up from the copy's seq once reachable again after opening offline", async () => {
      await closeAfterTyping("mine ", { online: true })
      server.api.listUpdates.mockRejectedValueOnce(offline)
      const client = connect(server)
      await client.sync.start()
      server.writeElsewhere("theirs")

      await client.sync.catchUp()

      expect({ text: client.text(), after: server.api.listUpdates.mock.calls.map((call) => call[2]) }).toEqual({
        text: "mine theirs",
        after: [1, 1],
      })
    })

    it("should remove the local copy when catching up finds the doc gone", async () => {
      const client = connect(server)
      await client.sync.start()
      await vi.advanceTimersByTimeAsync(LOCAL_COPY_SAVE_MS)
      server.api.listUpdates.mockRejectedValue(new ApiError(404, "STREAM_NOT_FOUND", "gone"))

      await client.sync.catchUp()

      expect(localCopies.copy).toBeNull()
    })
  })

  describe("between tabs", () => {
    beforeEach(() => {
      Object.defineProperty(navigator, "locks", { value: new FakeLocks(), configurable: true })
    })

    afterEach(() => {
      Reflect.deleteProperty(navigator, "locks")
    })

    /** Lets the tabs' messages, each a microtask, run to the end of every chain they start. */
    async function settle(): Promise<void> {
      for (let round = 0; round < 50; round++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
    }

    async function openTwo() {
      const leader = connect(server)
      await leader.sync.start()
      const follower = connect(server)
      await follower.sync.start()
      await settle()
      return { leader, follower }
    }

    it("should leave the doc to the next tab when stopped before the election", async () => {
      const unmounted = connect(server)
      const started = unmounted.sync.start()
      unmounted.sync.stop()
      server.clients.delete(unmounted.sync)
      await started
      type(server.doc, "on the server ")
      server.log.push({
        seq: 1,
        update: bytesToBase64(Y.encodeStateAsUpdate(server.doc)),
        actorId: "usr_1",
        actorType: "user",
      })

      const mounted = connect(server)
      await mounted.sync.start()
      await settle()

      expect({ status: mounted.sync.getStatus(), text: mounted.text() }).toEqual({
        status: { phase: "ready" },
        text: "on the server ",
      })
    })

    it("should show each tab's edits in the other at once while offline", async () => {
      const { leader, follower } = await openTwo()
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)

      type(follower.ydoc, "from the follower ")
      type(leader.ydoc, "from the leader ")
      await settle()

      expect({ leader: leader.text(), follower: follower.text(), posts: server.api.postUpdate.mock.calls }).toEqual({
        leader: follower.text(),
        follower: expect.stringMatching(/^(?=.*from the follower )(?=.*from the leader )/),
        posts: [],
      })
    })

    it("should send a following tab's edit from the leading tab", async () => {
      const { leader, follower } = await openTwo()

      type(follower.ydoc, "typed in the follower ")
      await settle()
      await leader.sync.flush()

      expect({ server: server.text, follower: follower.sync.getStatus() }).toEqual({
        server: "typed in the follower ",
        follower: { phase: "ready" },
      })
    })

    it("should bring back a deleted block with its offline edit once when two tabs open the saved copy", async () => {
      server.writeContent(doc(alpha, beta, gamma))
      const first = connect(server)
      await first.sync.start()
      await settle()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      writeDoc(first.ydoc, doc(alpha, block(blockIds.b, "beta mine"), gamma))
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      first.sync.stop()
      server.clients.delete(first.sync)
      await settle()
      server.writeContent(doc(alpha, gamma))
      online.mockRestore()

      const { leader, follower } = await openTwo()
      await leader.sync.flush()
      await settle()

      const expected = ["paragraph: alpha", "paragraph: beta mine", "paragraph: gamma"]
      expect({
        server: blocksOf(server.doc),
        leader: blocksOf(leader.ydoc),
        follower: blocksOf(follower.ydoc),
      }).toEqual({ server: expected, leader: expected, follower: expected })
    })

    it("should keep a following tab's edit to a block an agent deletes before the edit reaches the leading tab", async () => {
      server.writeContent(doc(alpha, beta, gamma))
      const { leader, follower } = await openTwo()

      writeDoc(follower.ydoc, doc(alpha, block(blockIds.b, "beta mine"), gamma))
      leader.sync.receive(server.writeContent(doc(alpha, gamma)))
      await settle()
      await leader.sync.flush()
      await settle()

      const expected = ["paragraph: alpha", "paragraph: beta mine", "paragraph: gamma"]
      expect({
        server: blocksOf(server.doc),
        leader: blocksOf(leader.ydoc),
        follower: blocksOf(follower.ydoc),
      }).toEqual({ server: expected, leader: expected, follower: expected })
    })

    it("should send a following tab's offline edits once the leading tab closes", async () => {
      const { leader, follower } = await openTwo()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      type(follower.ydoc, "kept across the hand-over ")
      await settle()

      leader.sync.stop()
      server.clients.delete(leader.sync)
      online.mockRestore()
      await settle()
      await follower.sync.flush()

      expect({ server: server.text, follower: follower.sync.getStatus() }).toEqual({
        server: "kept across the hand-over ",
        follower: { phase: "ready" },
      })
    })

    it("should send what a tab typed while following when it is typed in during the takeover", async () => {
      const { leader, follower } = await openTwo()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      type(follower.ydoc, "while following ")
      await settle()
      leader.sync.stop()
      server.clients.delete(leader.sync)
      // The closing tab's copy has not landed when the next one reads it.
      localCopies.copy = null
      online.mockRestore()
      const real = server.api.get.getMockImplementation()!
      const loaded = deferred()
      server.api.get.mockImplementationOnce(async (...args) => {
        await loaded.promise
        return real(...args)
      })
      await settle()

      type(follower.ydoc, "taking over. ")
      await settle()
      loaded.release()
      await settle()
      await follower.sync.flush()

      expect({ server: server.text, rejections: follower.rejections }).toEqual({
        server: "while following taking over. ",
        rejections: [],
      })
    })

    it("should bring back a deleted block with a following tab's offline edit when the leading tab's copy has not landed", async () => {
      server.writeContent(doc(alpha, beta, gamma))
      const { leader, follower } = await openTwo()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      writeDoc(follower.ydoc, doc(alpha, block(blockIds.b, "beta mine"), gamma))
      await settle()
      leader.sync.stop()
      server.clients.delete(leader.sync)
      localCopies.copy = null
      server.writeContent(doc(alpha, gamma))
      online.mockRestore()
      await settle()
      await follower.sync.flush()
      await settle()

      const expected = ["paragraph: alpha", "paragraph: beta mine", "paragraph: gamma"]
      expect({ server: blocksOf(server.doc), follower: blocksOf(follower.ydoc) }).toEqual({
        server: expected,
        follower: expected,
      })
    })

    it("should queue a following tab's last edit when both tabs close before the leading tab gets it", async () => {
      const { leader, follower } = await openTwo()

      type(follower.ydoc, "last words ")
      leader.sync.stop()
      follower.sync.stop()
      server.clients.clear()
      await settle()

      expect({ server: server.text, enqueued }).toEqual({
        server: "",
        enqueued: [{ docId: DOC_ID, text: "last words " }],
      })
    })

    it("should neither send nor queue a following tab's edits once the leading tab's send of them was refused", async () => {
      const { leader, follower } = await openTwo()
      server.failNextPost(403, "FORBIDDEN")
      type(follower.ydoc, "refused ")
      await settle()
      await leader.sync.flush()
      await settle()
      type(follower.ydoc, "built on the refused edit ")
      await settle()
      await leader.sync.flush()

      leader.sync.stop()
      server.clients.delete(leader.sync)
      await settle()
      follower.sync.stop()
      server.clients.clear()
      await settle()

      expect({ rejections: [leader.rejections, follower.rejections], posts: postedTexts(server), enqueued }).toEqual({
        rejections: [["FORBIDDEN"], ["FORBIDDEN"]],
        posts: ["refused "],
        enqueued: [],
      })
    })
  })

  describe("offline edits in a block the server replaces", () => {
    /** Opens the doc, then edits `beta` to `edited` while offline, leaving the edit unacked. */
    async function editBetaOffline(edited: JSONContent) {
      server.writeContent(doc(alpha, beta, gamma))
      const client = connect(server)
      await client.sync.start()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      writeDoc(client.ydoc, doc(alpha, edited, gamma))
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      online.mockRestore()
      return client
    }

    it("should keep an offline edit in a block an agent moved when the move arrives first", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(beta, alpha, gamma), doc(alpha, gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: beta mine", "paragraph: alpha", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should keep an offline edit in a block an agent moved when the edit reaches the server first", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(beta, alpha, gamma), doc(alpha, gamma))

      await client.sync.flush()
      await vi.advanceTimersByTimeAsync(0)
      await client.sync.flush()

      const expected = ["paragraph: beta mine", "paragraph: alpha", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should keep an offline edit in a moved block when the doc was closed and reopened before the move arrived", async () => {
      const first = await editBetaOffline(block(blockIds.b, "beta mine"))
      first.sync.stop()
      await vi.advanceTimersByTimeAsync(0)
      server.clients.delete(first.sync)
      server.writeContent(doc(beta, alpha, gamma), doc(alpha, gamma))

      const client = connect(server)
      await client.sync.start()
      await client.sync.flush()

      const expected = ["paragraph: beta mine", "paragraph: alpha", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should keep an offline edit in a block an agent turned into a heading", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(alpha, block(blockIds.b, "beta", "heading"), gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: alpha", "heading: beta mine", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should merge an offline edit with an agent's rewrite of the moved block", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(block(blockIds.b, "beta theirs"), alpha, gamma), doc(alpha, gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      // Two inserts at the same spot are ordered by Yjs client id, which is random.
      const [moved, ...rest] = blocksOf(client.ydoc)
      expect({
        moved: ["paragraph: beta theirs mine", "paragraph: beta mine theirs"].includes(moved!),
        rest,
        server: blocksOf(server.doc),
      }).toEqual({ moved: true, rest: ["paragraph: alpha", "paragraph: gamma"], server: [moved, ...rest] })
    })

    it("should keep the offline version beside the agent's when the two cannot merge", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta", "paragraph", [{ type: "bold" }]))
      server.writeContent(doc(alpha, block(blockIds.b, "beta", "codeBlock"), gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: alpha", "codeBlock: beta", "paragraph: beta", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should keep an offline heading level change in a block an agent moved", async () => {
      const heading = (level: number, text: string): JSONContent => ({
        type: "heading",
        attrs: { blockId: blockIds.b, level },
        content: [{ type: "text", text }],
      })
      server.writeContent(doc(alpha, heading(2, "beta"), gamma))
      const client = connect(server)
      await client.sync.start()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      writeDoc(client.ydoc, doc(alpha, heading(3, "beta"), gamma))
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      online.mockRestore()
      server.writeContent(doc(heading(2, "beta"), alpha, gamma), doc(alpha, gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const levelOf = (ydoc: Y.Doc) =>
        (yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_FRAGMENT)) as JSONContent).content?.[0]?.attrs?.level
      expect({ client: levelOf(client.ydoc), server: levelOf(server.doc), blocks: blocksOf(server.doc) }).toEqual({
        client: 3,
        server: 3,
        blocks: ["heading: beta", "paragraph: alpha", "paragraph: gamma"],
      })
    })

    it("should keep both halves of a block split offline when an agent moves it", async () => {
      const client = await editBetaOffline(block(blockIds.b, "be"))
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      const fragment = client.ydoc.getXmlFragment(DOC_FRAGMENT)
      const half = new Y.XmlElement("paragraph")
      fragment.insert(2, [half])
      half.setAttribute("blockId", blockIds.b)
      half.insert(0, [new Y.XmlText("ta mine")])
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      online.mockRestore()
      server.writeContent(doc(beta, alpha, gamma), doc(alpha, gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: be", "paragraph: alpha", "paragraph: ta mine", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should bring back a block an agent deleted with the offline edit in it", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(alpha, gamma))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: alpha", "paragraph: beta mine", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should bring back a list item an agent deleted with the offline edit in it", async () => {
      const item = (id: string, text: string): JSONContent => ({ type: "listItem", content: [block(id, text)] })
      const list = (...items: JSONContent[]): JSONContent => ({
        type: "bulletList",
        attrs: { blockId: "blk_0000000000000000000000000L" },
        content: items,
      })
      const itemsOf = (ydoc: Y.Doc) =>
        (
          (yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_FRAGMENT)) as JSONContent).content?.[0]?.content ?? []
        ).map((listItem) => listItem.content?.[0]?.content?.[0]?.text)
      server.writeContent(doc(list(item(blockIds.a, "one"), item(blockIds.b, "two"), item(blockIds.c, "three"))))
      const client = connect(server)
      await client.sync.start()
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
      writeDoc(client.ydoc, doc(list(item(blockIds.a, "one"), item(blockIds.b, "two mine"), item(blockIds.c, "three"))))
      await vi.advanceTimersByTimeAsync(FLUSH_CAP_MS)
      online.mockRestore()
      server.writeContent(doc(list(item(blockIds.a, "one"), item(blockIds.c, "three"))))

      await client.sync.catchUp()
      await client.sync.flush()

      expect({ client: itemsOf(client.ydoc), server: itemsOf(server.doc) }).toEqual({
        client: ["one", "two mine", "three"],
        server: ["one", "two mine", "three"],
      })
    })

    it("should not bring back edits the server refused when a later update deletes their block", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.failNextPost(403, "FORBIDDEN")
      await client.sync.flush()
      server.writeContent(doc(alpha, gamma))

      await client.sync.catchUp()

      expect({ rejections: client.rejections, client: blocksOf(client.ydoc) }).toEqual({
        rejections: ["FORBIDDEN"],
        client: ["paragraph: alpha", "paragraph: gamma"],
      })
    })

    it("should not add an edit twice when it reached the server before a move and the doc reopens", async () => {
      const first = await editBetaOffline(block(blockIds.b, "beta mine"))
      first.sync.stop()
      await vi.advanceTimersByTimeAsync(0)
      server.clients.delete(first.sync)
      const copy = localCopies.copy!
      await server.api.postUpdate(WORKSPACE_ID, DOC_ID, bytesToBase64(Y.mergeUpdates(copy.unsent)))
      server.writeContent(doc(block(blockIds.b, "beta mine"), alpha, gamma), doc(alpha, gamma))

      const client = connect(server)
      await client.sync.start()
      await client.sync.flush()

      const expected = ["paragraph: beta mine", "paragraph: alpha", "paragraph: gamma"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })

    it("should leave both edits in place when the agent edits another block", async () => {
      const client = await editBetaOffline(block(blockIds.b, "beta mine"))
      server.writeContent(doc(alpha, beta, block(blockIds.c, "delta")))

      await client.sync.catchUp()
      await client.sync.flush()

      const expected = ["paragraph: alpha", "paragraph: beta mine", "paragraph: delta"]
      expect({ client: blocksOf(client.ydoc), server: blocksOf(server.doc) }).toEqual({
        client: expected,
        server: expected,
      })
    })
  })
})
