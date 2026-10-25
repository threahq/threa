import { BLOCK_ID_PATTERN, type JSONContent } from "@threahq/types"
import { BLOCK_ID_NODE_TYPES } from "./schema/attributes"

const BLOCK_ID_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_ID_NODE_TYPES)

function isBlock(node: JSONContent): boolean {
  return BLOCK_ID_TYPE_SET.has(node.type ?? "")
}

function validBlockId(node: JSONContent): string | null {
  const id = node.attrs?.blockId
  return typeof id === "string" && BLOCK_ID_PATTERN.test(id) ? id : null
}

function withoutBlockIds(node: JSONContent): JSONContent {
  const { blockId: _blockId, ...attrs } = node.attrs ?? {}
  const { attrs: _attrs, content, ...rest } = node
  return {
    ...rest,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content ? { content: content.map(withoutBlockIds) } : {}),
  }
}

// Key order is normalized because a stored document comes back from jsonb with
// its keys reordered, while an incoming one keeps the order its sender built.
function contentKey(node: JSONContent): string {
  return JSON.stringify(withoutBlockIds(node), (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )
}

/**
 * Ids are unique within a document: a copied or split block that brought its
 * id along is minted a fresh one, so an anchor never resolves to two blocks.
 * Never mutates `doc`; returns it unchanged when every block already has an id.
 */
export function ensureBlockIds(doc: JSONContent, mintBlockId: () => string, previous?: JSONContent): JSONContent {
  // Ids never travel through markdown, so an edit sent as markdown arrives
  // id-less: a block whose content matches a block of the previous revision
  // takes that block's id back, so anchors on unchanged blocks survive.
  // An id the incoming document already carries is never carried onto
  // another block, wherever in document order its owner sits.
  const carried = new Map<string, string[]>()
  const claimed = new Set<string>()
  const index = (node: JSONContent, onBlock: (node: JSONContent, id: string) => void) => {
    const id = isBlock(node) ? validBlockId(node) : null
    if (id) onBlock(node, id)
    node.content?.forEach((child) => index(child, onBlock))
  }
  if (previous) {
    index(previous, (node, id) => {
      const key = contentKey(node)
      carried.set(key, [...(carried.get(key) ?? []), id])
    })
    index(doc, (_node, id) => claimed.add(id))
  }

  const seen = new Set<string>()
  const nextId = (node: JSONContent): string => {
    const queue = carried.get(contentKey(node)) ?? []
    while (queue.length > 0) {
      const candidate = queue.shift()!
      if (!seen.has(candidate) && !claimed.has(candidate)) return candidate
    }
    return mintBlockId()
  }

  const assign = (node: JSONContent): JSONContent => {
    let blockId: string | null = null
    let needsId = false
    if (isBlock(node)) {
      const current = validBlockId(node)
      blockId = current !== null && !seen.has(current) ? current : nextId(node)
      needsId = blockId !== current
      seen.add(blockId)
    }

    let childrenChanged = false
    const content = node.content?.map((child) => {
      const next = assign(child)
      if (next !== child) childrenChanged = true
      return next
    })

    if (!needsId && !childrenChanged) return node
    return {
      ...node,
      ...(needsId ? { attrs: { ...node.attrs, blockId } } : {}),
      ...(childrenChanged ? { content } : {}),
    }
  }

  return assign(doc)
}
