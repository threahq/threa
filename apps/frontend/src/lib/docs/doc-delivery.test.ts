import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { DOC_FRAGMENT, type JSONContent } from "@threahq/types"
import { deliverQueuedDocUpdate, DocOpenElsewhereError } from "./doc-delivery"
import type { DocLocalCopies, DocLocalCopy } from "./doc-local-copy"
import type { DocsApi } from "./doc-sync"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

function paragraph(blockId: string, text: string): JSONContent {
  return { type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] }
}

const alpha = paragraph("blk_0000000000000000000000000A", "alpha")
const beta = paragraph("blk_0000000000000000000000000B", "beta")
const gamma = paragraph("blk_0000000000000000000000000C", "gamma")

function writeDoc(ydoc: Y.Doc, ...blocks: JSONContent[]): void {
  const node = getThreaSchema().nodeFromJSON({ type: "doc", content: blocks })
  updateYFragment(ydoc, ydoc.getXmlFragment(DOC_FRAGMENT), node, { mapping: new Map(), isOMark: new Map() })
}

function blocksOf(ydoc: Y.Doc): string[] {
  const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_FRAGMENT)) as JSONContent
  return (json.content ?? []).map((node) => (node.content ?? []).map((child) => child.text ?? "").join(""))
}

/** The server's log; each write is one row, as the docs API stores it. */
class FakeServer {
  readonly doc = new Y.Doc()
  readonly rows: { seq: number; update: string }[] = []

  write(fn: (ydoc: Y.Doc) => void): void {
    const before = Y.encodeStateVector(this.doc)
    this.doc.transact(() => fn(this.doc))
    this.rows.push({ seq: this.rows.length + 1, update: bytesToBase64(Y.encodeStateAsUpdate(this.doc, before)) })
  }

  readonly api = {
    listUpdates: vi.fn(async (_ws: string, _doc: string, after: number) => ({
      updates: this.rows
        .filter((row) => row.seq > after)
        .map((row) => ({ ...row, actorId: "usr_1", actorType: "user" as const })),
      hasMore: false,
    })),
    postUpdate: vi.fn(async (_ws: string, _doc: string, update: string) => {
      const before = Y.snapshot(this.doc)
      Y.applyUpdate(this.doc, base64ToBytes(update))
      if (Y.equalSnapshots(before, Y.snapshot(this.doc))) {
        return { seq: this.rows.length, applied: false, touchedBlockIds: [] }
      }
      this.rows.push({ seq: this.rows.length + 1, update })
      return { seq: this.rows.length, applied: true, touchedBlockIds: [] }
    }),
  }
}

function localCopies(copy: Omit<DocLocalCopy, "queuedIds"> | null) {
  const store = { copy }
  const copies: DocLocalCopies = {
    read: async () => (store.copy ? { ...store.copy, queuedIds: [] } : null),
    write: async (_ws, _doc, { state, seq, unsent }) => {
      store.copy = { state, seq, unsent: unsent ? [unsent] : [] }
    },
    remove: async () => {
      store.copy = null
    },
  }
  return { store, copies }
}

/** A device that saved its copy at the server's head, then edited `beta` offline into the queue. */
function deviceWithOfflineEdit(server: FakeServer) {
  const device = new Y.Doc()
  Y.applyUpdate(device, Y.encodeStateAsUpdate(server.doc))
  const state = Y.encodeStateAsUpdate(device)
  const before = Y.encodeStateVector(device)
  writeDoc(device, alpha, paragraph(beta.attrs!.blockId as string, "beta mine"), gamma)
  const update = bytesToBase64(Y.encodeStateAsUpdate(device, before))
  return { copy: { state, seq: server.rows.length, unsent: [] }, update }
}

describe("deliverQueuedDocUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("should keep a closed doc's queued edit in a block an agent moved", async () => {
    const server = new FakeServer()
    server.write((ydoc) => writeDoc(ydoc, alpha, beta, gamma))
    const { copy, update } = deviceWithOfflineEdit(server)
    server.write((ydoc) => {
      writeDoc(ydoc, alpha, gamma)
      writeDoc(ydoc, beta, alpha, gamma)
    })
    const { store, copies } = localCopies(copy)

    await deliverQueuedDocUpdate({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      update,
      api: server.api as unknown as DocsApi,
      localCopies: copies,
    })

    const saved = new Y.Doc()
    Y.applyUpdate(saved, store.copy!.state)
    expect({
      server: blocksOf(server.doc),
      copy: { blocks: blocksOf(saved), seq: store.copy!.seq, unsent: store.copy!.unsent },
    }).toEqual({
      server: ["beta mine", "alpha", "gamma"],
      copy: { blocks: ["beta mine", "alpha", "gamma"], seq: 3, unsent: [] },
    })
  })

  it("should not add the rescued edit twice when the retry follows a lost response", async () => {
    const server = new FakeServer()
    server.write((ydoc) => writeDoc(ydoc, alpha, beta, gamma))
    const { copy, update } = deviceWithOfflineEdit(server)
    server.write((ydoc) => {
      writeDoc(ydoc, alpha, gamma)
      writeDoc(ydoc, beta, alpha, gamma)
    })
    const { copies } = localCopies(copy)
    const stored = server.api.postUpdate.getMockImplementation()!
    server.api.postUpdate.mockImplementationOnce(async (...args) => {
      await stored(...args)
      throw new TypeError("Failed to fetch")
    })
    const deliver = () =>
      deliverQueuedDocUpdate({
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        update,
        api: server.api as unknown as DocsApi,
        localCopies: copies,
      })

    await expect(deliver()).rejects.toBeInstanceOf(TypeError)
    await deliver()

    expect(blocksOf(server.doc)).toEqual(["beta mine", "alpha", "gamma"])
  })

  it("should post the queued bytes as they are when the device holds no copy of the doc", async () => {
    const server = new FakeServer()
    server.write((ydoc) => writeDoc(ydoc, alpha, beta, gamma))
    const { update } = deviceWithOfflineEdit(server)
    const { store, copies } = localCopies(null)

    await deliverQueuedDocUpdate({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      update,
      api: server.api as unknown as DocsApi,
      localCopies: copies,
    })

    expect({ posted: server.api.postUpdate.mock.calls, copy: store.copy }).toEqual({
      posted: [[WORKSPACE_ID, DOC_ID, update]],
      copy: null,
    })
  })

  it("should leave the edit to the tab that holds the doc open", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null),
      },
    })
    const server = new FakeServer()
    server.write((ydoc) => writeDoc(ydoc, alpha, beta, gamma))
    const { copy, update } = deviceWithOfflineEdit(server)
    const { copies } = localCopies(copy)

    const delivery = deliverQueuedDocUpdate({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      update,
      api: server.api as unknown as DocsApi,
      localCopies: copies,
    })

    await expect(delivery).rejects.toBeInstanceOf(DocOpenElsewhereError)
    expect(server.api.postUpdate).not.toHaveBeenCalled()
  })
})
