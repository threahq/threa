import * as Y from "yjs"
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { DOC_FRAGMENT, type JSONContent } from "@threahq/types"

type Parent = Y.XmlFragment | Y.XmlElement

/**
 * Local edits a server update is about to delete, read before it is applied: a
 * move, or a rewrite that changes a block's type, deletes the block's Y element
 * and writes a fresh one, and edits inside the old element would vanish with it.
 */
interface EditsAtRisk {
  /** Outermost edited elements the update deletes, each with the server's version before the update. */
  blocks: { element: Y.XmlElement; blockId: string | null; base: JSONContent }[]
  /** Every local element as JSON, before the update. */
  mine: Map<Y.XmlElement, JSONContent>
}

function itemKey(element: Y.XmlElement): string | null {
  const item = element._item
  return item ? `${item.id.client}:${item.id.clock}` : null
}

function blockIdOf(element: Y.XmlElement): string | null {
  const id = element.getAttribute("blockId")
  return typeof id === "string" ? id : null
}

function childElements(parent: Parent): Y.XmlElement[] {
  return parent.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
}

function eachElement(parent: Parent, visit: (element: Y.XmlElement) => void): void {
  for (const child of childElements(parent)) {
    visit(child)
    eachElement(child, visit)
  }
}

function elementsBy(ydoc: Y.Doc, key: (element: Y.XmlElement) => string | null): Map<string, Y.XmlElement> {
  const found = new Map<string, Y.XmlElement>()
  eachElement(ydoc.getXmlFragment(DOC_FRAGMENT), (element) => {
    const value = key(element)
    if (value !== null && !found.has(value)) found.set(value, element)
  })
  return found
}

/** A text run is never an element, so with text skipped the JSON children line up with the Y children. */
function jsonByElement(ydoc: Y.Doc): Map<Y.XmlElement, JSONContent> {
  const fragment = ydoc.getXmlFragment(DOC_FRAGMENT)
  const found = new Map<Y.XmlElement, JSONContent>()
  const pair = (parent: Parent, json: JSONContent) => {
    const nodes = (json.content ?? []).filter((node) => node.type !== "text")
    childElements(parent).forEach((element, index) => {
      const node = nodes[index]
      if (!node) return
      found.set(element, node)
      pair(element, node)
    })
  }
  pair(fragment, yXmlFragmentToProsemirrorJSON(fragment) as JSONContent)
  return found
}

function isDeleted(element: Y.XmlElement): boolean {
  return element._item?.deleted ?? false
}

function writeBlock(ydoc: Y.Doc, target: Parent, json: JSONContent): void {
  const schema = getThreaSchema()
  const node =
    target instanceof Y.XmlElement ? schema.nodeFromJSON(json) : schema.node("doc", null, [schema.nodeFromJSON(json)])
  updateYFragment(ydoc, target, node, { mapping: new Map(), isOMark: new Map() })
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Each attribute takes the local value when the local side changed it, else the server's. */
function mergeAttrs(
  base: JSONContent["attrs"] = {},
  mine: JSONContent["attrs"] = {},
  theirs: JSONContent["attrs"] = {}
): Record<string, unknown> {
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])
  return Object.fromEntries([...keys].map((key) => [key, sameJson(mine[key], base[key]) ? theirs[key] : mine[key]]))
}

/** Yjs does the merge: both sides become diffs against `base`, so text typed on each side survives. */
function mergeBlock(base: JSONContent, mine: JSONContent, theirs: JSONContent): JSONContent | null {
  // A server type change wins; merging across types would replace the element again and drop the other side.
  const type = theirs.type !== base.type ? theirs.type : mine.type
  const attrs = mergeAttrs(base.attrs, mine.attrs, theirs.attrs)
  const shape = (node: JSONContent): JSONContent => ({ ...node, type, attrs })
  const root = new Y.Doc()
  try {
    writeBlock(root, root.getXmlFragment("block"), shape(base))
    const start = Y.encodeStateAsUpdate(root)
    const diff = (json: JSONContent) => {
      const side = new Y.Doc()
      Y.applyUpdate(side, start)
      const before = Y.encodeStateVector(side)
      writeBlock(side, side.getXmlFragment("block"), shape(json))
      return Y.encodeStateAsUpdate(side, before)
    }
    Y.applyUpdate(root, diff(mine))
    Y.applyUpdate(root, diff(theirs))
    const merged = (yXmlFragmentToProsemirrorJSON(root.getXmlFragment("block")) as JSONContent).content?.[0]
    if (!merged) return null
    getThreaSchema().nodeFromJSON(merged).check()
    return merged
  } catch {
    return null
  } finally {
    root.destroy()
  }
}

function withoutBlockIds(node: JSONContent): JSONContent {
  const { blockId: _blockId, ...attrs } = node.attrs ?? {}
  return { ...node, attrs, ...(node.content ? { content: node.content.map(withoutBlockIds) } : {}) }
}

function insertBlock(ydoc: Y.Doc, parent: Parent, index: number, json: JSONContent): void {
  const element = new Y.XmlElement(json.type)
  parent.insert(index, [element])
  writeBlock(ydoc, element, json)
}

/** The deleted element itself, or its highest deleted ancestor: what has to come back for it to have a place. */
function outermostDeleted(element: Y.XmlElement): Y.XmlElement {
  let top = element
  while (top.parent instanceof Y.XmlElement && isDeleted(top.parent)) top = top.parent
  return top
}

/** Where a deleted child stood among its parent's live children. */
function liveIndexOf(parent: Parent, element: Y.XmlElement): number {
  let index = 0
  for (let item = parent._start; item && item !== element._item; item = item.right) {
    if (!item.deleted && item.countable) index++
  }
  return index
}

/** Compared by Y item, not `blockId`: an offline split copies its block's id until the server stamps a new one. */
function readEditsAtRisk(local: Y.Doc, server: Y.Doc, update: Uint8Array): EditsAtRisk | null {
  const { ds } = Y.decodeUpdate(update)
  if (ds.clients.size === 0) return null
  const held = elementsBy(server, itemKey)
  const atRisk: { element: Y.XmlElement; held: Y.XmlElement }[] = []
  const walk = (parent: Parent, parentDeleted: boolean) => {
    for (const element of childElements(parent)) {
      const item = element._item
      const deleted = parentDeleted || (item !== null && Y.isDeleted(ds, item.id))
      const key = itemKey(element)
      const serverCopy = key === null ? undefined : held.get(key)
      if (deleted && serverCopy && serverCopy.toString() !== element.toString()) {
        atRisk.push({ element, held: serverCopy })
        continue
      }
      walk(element, deleted)
    }
  }
  walk(local.getXmlFragment(DOC_FRAGMENT), false)
  if (atRisk.length === 0) return null
  const base = jsonByElement(server)
  return {
    // Read now: a deleted element's attributes read as unset.
    blocks: atRisk.map(({ element, held }) => ({ element, blockId: blockIdOf(element), base: base.get(held)! })),
    mine: jsonByElement(local),
  }
}

/**
 * Carries each at-risk edit over as a local edit for the caller to send on. A block still
 * on the server under its `blockId` gets the edit merged in; a merge the schema rejects
 * keeps both versions, local beside theirs with its ids left for the server to mint. A
 * block the update deleted outright comes back where it stood, with the edit: losing
 * the edit is worse than undoing a delete.
 */
function carryOver(local: Y.Doc, server: Y.Doc, risk: EditsAtRisk): void {
  const serverBlocks = elementsBy(server, blockIdOf)
  const localByItem = elementsBy(local, itemKey)
  const theirs = jsonByElement(local)
  const restored = new Set<Y.XmlElement>()
  local.transact(() => {
    for (const { element, blockId, base } of risk.blocks) {
      const mine = risk.mine.get(element)!
      const live = blockId === null ? undefined : serverBlocks.get(blockId)
      const liveKey = live ? itemKey(live) : null
      const target = liveKey === null ? undefined : localByItem.get(liveKey)
      if (target) {
        const current = theirs.get(target)!
        if (sameJson(current, mine)) continue
        const merged = mergeBlock(base, mine, current)
        if (merged) {
          writeBlock(local, target, merged)
        } else {
          const parent = target.parent as Parent
          insertBlock(local, parent, parent.toArray().indexOf(target) + 1, withoutBlockIds(mine))
        }
        continue
      }
      const top = outermostDeleted(element)
      if (restored.has(top)) continue
      restored.add(top)
      const parent = top.parent as Parent
      insertBlock(local, parent, liveIndexOf(parent, top), risk.mine.get(top)!)
    }
  })
}

/**
 * Applies a server update to the server's doc and the local one. With `rescue`, local
 * edits the update would delete are carried over (see `carryOver`).
 */
export function applyServerUpdate(
  local: Y.Doc,
  server: Y.Doc,
  update: Uint8Array,
  origin: unknown,
  rescue: boolean
): void {
  const risk = rescue ? readEditsAtRisk(local, server, update) : null
  Y.applyUpdate(server, update, origin)
  Y.applyUpdate(local, update, origin)
  if (risk) carryOver(local, server, risk)
}
