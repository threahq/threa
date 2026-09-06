/**
 * Cutting a document down to a position range, matching ProseMirror's
 * `Node.cut` exactly: ancestors of the cut are kept, text nodes are cut on
 * character boundaries with their marks intact, atoms are kept whole or dropped
 * whole, and containers the cut empties out stay behind as empty nodes.
 */

import type { ContentRange, JSONContent } from "@threahq/types"

import { docContentSize, LEAF_NODE_TYPES, nodeSize } from "./positions"

/**
 * The sub-document covered by `[from, to)`, as a `doc` node. Positions are the
 * doc's own content positions (see `positions.ts`) — validate them with
 * `isRangeValid` first; like `Fragment.cut` this stops at the document's edges
 * rather than reporting a position that isn't there.
 */
export function sliceContent(doc: JSONContent, from: number, to: number): JSONContent {
  return cutNode(doc, from, to)
}

/** Integers, in bounds, non-empty. `to` is exclusive. */
export function isRangeValid(doc: JSONContent, range: ContentRange): boolean {
  const { from, to } = range
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  return from >= 0 && from < to && to <= docContentSize(doc)
}

/**
 * `null` for "the whole message" — both for an absent range and for one that
 * covers the entire document, so a full-message reference has one wire form.
 */
export function normalizeRange(doc: JSONContent, range: ContentRange | null | undefined): ContentRange | null {
  if (!range) return null
  if (range.from === 0 && range.to === docContentSize(doc)) return null
  return { from: range.from, to: range.to }
}

/**
 * True when a slice carries nothing a reader would see: no atom nodes and no
 * non-whitespace text. Hard breaks alone don't make a slice worth quoting.
 */
export function isEmptySlice(doc: JSONContent): boolean {
  let empty = true
  const walk = (node: JSONContent): void => {
    if (!empty) return
    if (node.type === "text") {
      if ((node.text ?? "").trim().length > 0) empty = false
      return
    }
    if (node.type !== "hardBreak" && LEAF_NODE_TYPES.has(node.type ?? "")) {
      empty = false
      return
    }
    for (const child of node.content ?? []) {
      walk(child)
    }
  }
  walk(doc)
  return empty
}

function cutNode(node: JSONContent, from: number, to: number): JSONContent {
  if (node.type === "text") {
    const text = node.text ?? ""
    if (from === 0 && to === text.length) return node
    return { ...node, text: text.slice(from, to) }
  }
  const size = docContentSize(node)
  if (from === 0 && to === size) return node
  return withContent(node, cutChildren(node.content ?? [], from, to))
}

function cutChildren(children: JSONContent[], from: number, to: number): JSONContent[] {
  if (to <= from) return []
  const result: JSONContent[] = []
  let pos = 0
  for (const child of children) {
    if (pos >= to) break
    const size = nodeSize(child)
    const end = pos + size
    if (end > from) {
      if (pos < from || end > to) {
        result.push(
          child.type === "text"
            ? cutNode(child, Math.max(0, from - pos), Math.min((child.text ?? "").length, to - pos))
            : cutNode(child, Math.max(0, from - pos - 1), Math.min(docContentSize(child), to - pos - 1))
        )
      } else {
        result.push(child)
      }
    }
    pos = end
  }
  return result
}

function withContent(node: JSONContent, content: JSONContent[]): JSONContent {
  const next: JSONContent = { ...node }
  // `Node.toJSON()` omits `content` for an empty fragment; keeping the key
  // would make an otherwise identical slice compare unequal to a cut node.
  if (content.length > 0) next.content = content
  else delete next.content
  return next
}
