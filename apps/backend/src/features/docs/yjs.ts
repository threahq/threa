import * as Y from "yjs"
import { prosemirrorJSONToYDoc, updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror"
import { getThreaSchema, normalizeContentJson } from "@threahq/prosemirror/schema"
import type { JSONContent } from "@threahq/types"

/** The fragment TipTap's Collaboration extension binds by default; y-prosemirror's own default is "prosemirror". */
export const DOC_FRAGMENT = "default"

/** ProseMirror requires `block+`, but a Y fragment can be empty; this is the stored shape of an empty doc. */
export const EMPTY_DOC_JSON: JSONContent = { type: "doc", content: [] }

export class DocUpdateNotApplicableError extends Error {
  constructor() {
    super("Yjs update depends on state the doc does not have")
    this.name = "DocUpdateNotApplicableError"
  }
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
  Y.applyUpdate(ydoc, update)
  if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) throw new DocUpdateNotApplicableError()
}

export function encodeFullState(ydoc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(ydoc)
}

/** Throws `InvalidContentError` when the fragment holds content the Threa schema rejects. */
export function ydocToContentJson(ydoc: Y.Doc): JSONContent {
  if (ydoc.getXmlFragment(DOC_FRAGMENT).length === 0) return EMPTY_DOC_JSON
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
