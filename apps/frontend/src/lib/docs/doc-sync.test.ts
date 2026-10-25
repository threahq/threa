import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocState, DocUpdatedPayload, DocUpdateView, Stream } from "@threahq/types"
import { ApiError } from "@/api/client"
import { DocSync, FLUSH_DEBOUNCE_MS, REMOTE_ORIGIN } from "./doc-sync"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"
const DEBOUNCE_MS = FLUSH_DEBOUNCE_MS
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
      async (): Promise<DocState> => ({
        stream: { id: DOC_ID } as Stream,
        seq: this.seq,
        state: bytesToBase64(Y.encodeStateAsUpdate(this.doc)),
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
      this.broadcast(seq)
      return { seq, touchedBlockIds: [] }
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
    const seq = this.store(bytesToBase64(Y.encodeStateAsUpdate(other, before)))
    return this.payload(seq)
  }

  broadcast(seq: number): void {
    for (const client of this.clients) client.receive(this.payload(seq))
  }

  private store(update: string): number {
    Y.applyUpdate(this.doc, base64ToBytes(update))
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

function deferred(): Hold & { promise: Promise<void> } {
  let release!: () => void
  let fail!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}

function connect(server: FakeDocServer) {
  const ydoc = new Y.Doc()
  const rejections: string[] = []
  const sync = new DocSync({
    workspaceId: WORKSPACE_ID,
    docId: DOC_ID,
    ydoc,
    api: server.api,
    onRejected: (refusal) => rejections.push(refusal.code),
  })
  server.clients.add(sync)
  return { ydoc, sync, rejections, text: () => ydoc.getText("t").toString() }
}

function type(ydoc: Y.Doc, text: string): void {
  const ytext = ydoc.getText("t")
  ytext.insert(ytext.length, text)
}

describe("DocSync", () => {
  let server: FakeDocServer

  beforeEach(() => {
    vi.useFakeTimers()
    server = new FakeDocServer()
  })

  afterEach(() => {
    for (const client of server.clients) client.stop()
    vi.useRealTimers()
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

  it("posts local edits as one merged update after the debounce", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "a")
    await vi.advanceTimersByTimeAsync(200)
    type(client.ydoc, "b")
    await vi.advanceTimersByTimeAsync(200)
    type(client.ydoc, "c")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(server.api.postUpdate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      serverText: server.text,
      status: client.sync.getStatus(),
    }).toEqual({ posts: 1, serverText: "abc", status: { phase: "ready" } })
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
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      await vi.advanceTimersByTimeAsync(LONGEST_BACKOFF_MS)

      expect({
        posts: server.api.postUpdate.mock.calls.length,
        gets: server.api.get.mock.calls.length,
        status: client.sync.getStatus(),
        rejections: client.rejections,
      }).toEqual({ posts: 1, gets: 2, status: { phase: "ready" }, rejections: [code] })
    }
  )

  it("keeps a failed send and retries it with backoff", async () => {
    const client = connect(server)
    await client.sync.start()
    server.api.postUpdate.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    server.failNextPost(503, "UNAVAILABLE")

    type(client.ydoc, "kept")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(999)
    expect(server.api.postUpdate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.api.postUpdate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)

    expect({ posts: server.api.postUpdate.mock.calls.length, serverText: server.text }).toEqual({
      posts: 3,
      serverText: "kept",
    })
  })

  it("converges two clients editing the same doc", async () => {
    const alice = connect(server)
    const bob = connect(server)
    await alice.sync.start()
    await bob.sync.start()

    type(alice.ydoc, "Rotation tracker")
    type(bob.ydoc, "Second paragraph")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    type(bob.ydoc, "!")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

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

  it("sends an edit made while a post is in flight exactly once, after the post settles", async () => {
    const client = connect(server)
    await client.sync.start()
    const post = server.holdNextPost()

    type(client.ydoc, "a")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    type(client.ydoc, "b")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(server.api.postUpdate).toHaveBeenCalledTimes(1)
    post.release()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    const posted = server.api.postUpdate.mock.calls.map((call) => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, base64ToBytes(call[2]))
      return doc.getText("t").toString()
    })
    expect({ posted, serverText: server.text, status: client.sync.getStatus() }).toEqual({
      posted: ["a", ""],
      serverText: "ab",
      status: { phase: "ready" },
    })
  })

  it("keeps its seq when its own echo lands before the post result", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "mine")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
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

  it("leaves no timers and sends nothing more when stopped mid-post", async () => {
    const client = connect(server)
    await client.sync.start()
    const post = server.holdNextPost()

    type(client.ydoc, "x")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    client.sync.stop()
    post.fail(new ApiError(400, "DOC_UPDATE_NOT_APPLICABLE", "missing deps"))
    await vi.advanceTimersByTimeAsync(0)

    expect({ timers: vi.getTimerCount(), posts: server.api.postUpdate.mock.calls.length }).toEqual({
      timers: 0,
      posts: 1,
    })
  })

  it("sends edits still inside the debounce window when stopped", async () => {
    const client = connect(server)
    await client.sync.start()

    type(client.ydoc, "last words")
    client.sync.stop()
    await vi.advanceTimersByTimeAsync(0)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      serverText: server.text,
      timers: vi.getTimerCount(),
    }).toEqual({
      posts: 1,
      serverText: "last words",
      timers: 0,
    })
  })

  it("sends what was typed during an in-flight post after it settles when stopped", async () => {
    const client = connect(server)
    await client.sync.start()
    const post = server.holdNextPost()

    type(client.ydoc, "a")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    type(client.ydoc, "b")
    client.sync.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.api.postUpdate).toHaveBeenCalledTimes(1)
    post.release()
    await vi.advanceTimersByTimeAsync(0)

    expect({ posts: server.api.postUpdate.mock.calls.length, serverText: server.text }).toEqual({
      posts: 2,
      serverText: "ab",
    })
  })

  it("resends an in-flight post that fails transiently after stop, with what was typed after it", async () => {
    const client = connect(server)
    await client.sync.start()
    const post = server.holdNextPost()

    type(client.ydoc, "first")
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    type(client.ydoc, " second")
    client.sync.stop()
    post.fail(new TypeError("Failed to fetch"))
    await vi.advanceTimersByTimeAsync(0)

    expect({ posts: server.api.postUpdate.mock.calls.length, serverText: server.text }).toEqual({
      posts: 2,
      serverText: "first second",
    })
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
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(seen).toEqual([{ phase: "loading" }, { phase: "ready" }])
  })
})
