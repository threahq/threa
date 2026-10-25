import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocState, DocUpdatedOutboxPayload, DocUpdateView, Stream } from "@threahq/types"
import { ApiError } from "@/api/client"
import { DocSync, REMOTE_ORIGIN } from "./doc-sync"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

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

  /** Another writer's edit, stored but not broadcast; returns its payload for delivery by hand. */
  writeElsewhere(text: string): DocUpdatedOutboxPayload {
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

  private payload(seq: number): DocUpdatedOutboxPayload {
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

function connect(server: FakeDocServer) {
  const ydoc = new Y.Doc()
  const sync = new DocSync({ workspaceId: WORKSPACE_ID, docId: DOC_ID, ydoc, api: server.api })
  server.clients.add(sync)
  return { ydoc, sync, text: () => ydoc.getText("t").toString() }
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
      status: { phase: "ready", saving: false },
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
    expect(client.sync.getStatus().saving).toBe(true)
    await vi.advanceTimersByTimeAsync(399)
    expect(server.api.postUpdate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      serverText: server.text,
      status: client.sync.getStatus(),
    }).toEqual({ posts: 1, serverText: "abc", status: { phase: "ready", saving: false } })
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

  it("catches up and resends once when the server lacks the update's dependencies", async () => {
    const client = connect(server)
    await client.sync.start()
    server.writeElsewhere("x")
    server.failNextPost(400, "DOC_UPDATE_NOT_APPLICABLE")

    type(client.ydoc, "y")
    await vi.advanceTimersByTimeAsync(400)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      fetched: server.api.listUpdates.mock.calls.length,
      clientText: client.text(),
      serverText: server.text,
      status: client.sync.getStatus(),
    }).toEqual({
      posts: 2,
      fetched: 1,
      clientText: server.text,
      serverText: expect.stringContaining("y"),
      status: { phase: "ready", saving: false },
    })
  })

  it("drops a refused update, reloads, and reports the rejection", async () => {
    const client = connect(server)
    await client.sync.start()
    server.failNextPost(400, "DOC_UPDATE_INVALID")

    type(client.ydoc, "bad")
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(10_000)

    expect({
      posts: server.api.postUpdate.mock.calls.length,
      gets: server.api.get.mock.calls.length,
      status: client.sync.getStatus(),
    }).toEqual({ posts: 1, gets: 2, status: { phase: "rejected", code: "DOC_UPDATE_INVALID", saving: false } })
  })

  it("keeps a failed send and retries it with backoff", async () => {
    const client = connect(server)
    await client.sync.start()
    server.api.postUpdate.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    server.failNextPost(503, "UNAVAILABLE")

    type(client.ydoc, "kept")
    await vi.advanceTimersByTimeAsync(400)
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
    await vi.advanceTimersByTimeAsync(400)
    type(bob.ydoc, "!")
    await vi.advanceTimersByTimeAsync(400)

    expect({
      alice: Y.encodeStateAsUpdate(alice.ydoc),
      bob: Y.encodeStateAsUpdate(bob.ydoc),
      server: Y.encodeStateAsUpdate(server.doc),
      seq: server.seq,
    }).toEqual({
      alice: Y.encodeStateAsUpdate(server.doc),
      bob: Y.encodeStateAsUpdate(server.doc),
      server: Y.encodeStateAsUpdate(server.doc),
      seq: 3,
    })
    expect(alice.text()).toMatch(/^(?=.*Rotation tracker)(?=.*Second paragraph).*!$/)
  })
})
