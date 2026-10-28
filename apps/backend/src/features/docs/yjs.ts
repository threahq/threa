import * as Y from "yjs"
import {
  prosemirrorJSONToYDoc,
  updateYFragment,
  yDocToProsemirrorJSON,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror"
import { ensureBlockIds } from "@threahq/prosemirror"
import { getThreaSchema, normalizeContentJson } from "@threahq/prosemirror/schema"
import { DOC_FRAGMENT, type JSONContent } from "@threahq/types"
import { blockId } from "../../lib/id"

/**
 * The Yjs client id of every server-authored write. Safe to share across
 * requests because writes are serialized under the doc's row lock, so each
 * one sees the clock the previous one left; a random id per request would add
 * a permanent state-vector entry per stamp. A client that drew the same id
 * would diverge silently, so its updates are refused.
 */
export const DOC_SERVER_CLIENT_ID = 1

export class DocUpdateNotApplicableError extends Error {
  constructor() {
    super("Yjs update depends on state the doc does not have")
    this.name = "DocUpdateNotApplicableError"
  }
}

export class DocUpdateInvalidError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Not a valid Yjs update for a Threa doc", options)
    this.name = "DocUpdateInvalidError"
  }
}

/** ProseMirror requires `block+`, but a Y fragment can be empty; this is the stored shape of an empty doc. */
function emptyDocJson(): JSONContent {
  return { type: "doc", content: [] }
}

/** Updates are applied in the order given (seq order); Yjs converges regardless, the order keeps replay deterministic. */
export function loadDocState({
  snapshot,
  updates,
}: {
  snapshot: Uint8Array | null
  updates: readonly Uint8Array[]
}): Y.Doc {
  const ydoc = new Y.Doc()
  ydoc.transact(() => {
    if (snapshot) Y.applyUpdate(ydoc, snapshot)
    for (const update of updates) Y.applyUpdate(ydoc, update)
  })
  return ydoc
}

/**
 * Yjs parks an update whose dependencies are missing instead of applying it;
 * stored, it would sit in the log without ever reaching the projection, so it
 * is refused. The doc is left mutated either way — discard it on throw.
 */
export function applyClientUpdate(ydoc: Y.Doc, update: Uint8Array): void {
  try {
    if (Y.decodeUpdate(update).structs.some((struct) => struct.id.client === DOC_SERVER_CLIENT_ID)) {
      throw new Error(`Client ${DOC_SERVER_CLIENT_ID} is the server`)
    }
    Y.applyUpdate(ydoc, update)
  } catch (error) {
    throw new DocUpdateInvalidError({ cause: error })
  }
  if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) throw new DocUpdateNotApplicableError()
}

/**
 * Applies a client update, then reads the merged state the way every
 * y-prosemirror client does: an element the schema rejects (a merge of two
 * individually valid edits can produce one) is deleted from the Y doc, and
 * block ids are stamped. Those server writes come back merged as
 * `serverUpdate` (the transactions' own updates, not a state-vector diff,
 * which would carry the doc's whole delete set), null when nothing changed.
 * Throws `DocUpdateNotApplicableError` or `DocUpdateInvalidError`; the doc is
 * left mutated either way.
 */
export function applyClientWrite(
  ydoc: Y.Doc,
  update: Uint8Array,
  previousBody: JSONContent
): { content: JSONContent; serverUpdate: Uint8Array | null } {
  applyClientUpdate(ydoc, update)
  const serverWrites: Uint8Array[] = []
  const onUpdate = (written: Uint8Array) => {
    serverWrites.push(written)
  }
  ydoc.on("update", onUpdate)
  try {
    let content = readRepairedContent(ydoc)
    const stamped = ensureBlockIds(content, blockId, previousBody)
    if (stamped !== content) {
      writeContentJson(ydoc, stamped)
      content = readRepairedContent(ydoc)
    }
    return { content, serverUpdate: serverWrites.length > 0 ? Y.mergeUpdates(serverWrites) : null }
  } finally {
    ydoc.off("update", onUpdate)
  }
}

/** Deletes schema-invalid elements from the fragment (y-prosemirror's repair) and returns the valid remainder. */
function readRepairedContent(ydoc: Y.Doc): JSONContent {
  let json: JSONContent
  try {
    json = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(DOC_FRAGMENT), getThreaSchema()).toJSON()
  } catch (error) {
    throw new DocUpdateInvalidError({ cause: error })
  }
  if (!json.content?.length) return emptyDocJson()
  try {
    return normalizeContentJson(json)
  } catch (error) {
    throw new DocUpdateInvalidError({ cause: error })
  }
}

export function encodeFullState(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc)
}

/** Throws `InvalidContentError` when the fragment holds content the Threa schema rejects. */
export function ydocToContentJson(ydoc: Y.Doc): JSONContent {
  if (ydoc.getXmlFragment(DOC_FRAGMENT).length === 0) return emptyDocJson()
  return normalizeContentJson(yDocToProsemirrorJSON(ydoc, DOC_FRAGMENT) as JSONContent)
}

export function contentJsonToYDoc(json: JSONContent): Y.Doc {
  return prosemirrorJSONToYDoc(getThreaSchema(), json, DOC_FRAGMENT)
}

/**
 * Rewrites the fragment to `json` as a minimal diff (unchanged nodes keep
 * their Y items, so concurrent client edits still merge) and returns the
 * update that write produced, empty-diff included.
 */
export function writeContentJson(ydoc: Y.Doc, json: JSONContent): Uint8Array {
  const before = Y.encodeStateVector(ydoc)
  const node = getThreaSchema().nodeFromJSON(json)
  updateYFragment(ydoc, ydoc.getXmlFragment(DOC_FRAGMENT), node, { mapping: new Map(), isOMark: new Map() })
  return Y.encodeStateAsUpdate(ydoc, before)
}

export function encodeUpdateBase64(update: Uint8Array): string {
  return Buffer.from(update).toString("base64")
}

export function decodeUpdateBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"))
}
