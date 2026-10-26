import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocState, DocUpdatedPayload, DocUpdateView, Stream } from "@threahq/types"
import { ApiError } from "@/api/client"
import * as operationQueueModule from "@/sync/operation-queue"
import { DocSync, FLUSH_CAP_MS, REMOTE_ORIGIN } from "./doc-sync"

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
  snapshotSeq = 0
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
      if (after < this.snapshotSeq) throw new ApiError(409, "DOC_UPDATES_BEHIND_SNAPSHOT", "behind snapshot")
      return { updates: this.log.filter((entry) => entry.seq > after) }
    }),
    postUpdate: vi.fn(async (_ws: string, _doc: string, update: string) => {
      const error = this.postErrors.shift()
      if (error) throw error
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

  broadcast(seq: number): void {
    for (const client of this.clients) client.receive(this.payload(seq))
  }

  /** Stores and logs the update; `null` when the doc already held every byte of it. */
  private store(update: string): number | null {
    const before = Y.encodeStateVector(this.doc)
    Y.applyUpdate(this.doc, base64ToBytes(update))
    if (sameBytes(before, Y.encodeStateVector(this.doc))) return null
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
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

describe("DocSync", () => {
  let server: FakeDocServer

  beforeEach(() => {
    vi.useFakeTimers()
    server = new FakeDocServer()
    enqueued = []
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

  it("reloads the full state when the log behind its seq was compacted", async () => {
    const client = connect(server)
    await client.sync.start()

    server.writeElsewhere("compacted")
    server.writeElsewhere(" away")
    server.snapshotSeq = 2
    await client.sync.catchUp()

    expect({ text: client.text(), gets: server.api.get.mock.calls.length }).toEqual({
      text: "compacted away",
      gets: 2,
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

  it("should send its state vector when reloading after the first load", async () => {
    server.writeElsewhere("base")
    const client = connect(server)
    await client.sync.start()
    const stateVector = bytesToBase64(Y.encodeStateVector(client.ydoc))
    server.writeElsewhere(" compacted")
    server.snapshotSeq = 2

    await client.sync.catchUp()

    expect({ text: client.text(), stateVectors: server.api.get.mock.calls.map((call) => call[2]) }).toEqual({
      text: "base compacted",
      stateVectors: [undefined, stateVector],
    })
  })

  it("adopts the server seq after a 409 reload", async () => {
    const client = connect(server)
    await client.sync.start()
    server.writeElsewhere("a")
    server.writeElsewhere("b")
    server.snapshotSeq = 2
    await client.sync.catchUp()

    client.sync.receive(server.writeElsewhere("c"))

    expect({ text: client.text(), fetched: server.api.listUpdates.mock.calls.length }).toEqual({
      text: "abc",
      fetched: 1,
    })
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
})
