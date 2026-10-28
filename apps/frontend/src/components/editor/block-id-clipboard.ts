import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model"

interface NodeJSON {
  attrs?: Record<string, unknown>
  content?: NodeJSON[]
  [key: string]: unknown
}

interface SliceJSON {
  content?: NodeJSON[]
  [key: string]: unknown
}

function mapNodes(nodes: NodeJSON[] | undefined, map: (attrs: Record<string, unknown>) => Record<string, unknown>) {
  return nodes?.map((node): NodeJSON => {
    const next: NodeJSON = { ...node }
    if (node.attrs && "blockId" in node.attrs) next.attrs = map(node.attrs)
    if (node.content) next.content = mapNodes(node.content, map)
    return next
  })
}

function withoutBlockIds(slice: SliceJSON): string {
  return JSON.stringify({ ...slice, content: mapNodes(slice.content, ({ blockId: _blockId, ...attrs }) => attrs) })
}

function blockIdsIn(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (typeof node.attrs.blockId === "string") ids.add(node.attrs.blockId)
  })
  return ids
}

/**
 * Block ids are not rendered, so they never survive the clipboard's HTML. A paste of exactly what
 * this editor last copied gets the copied slice back with the ids of blocks no longer in the doc,
 * so a block cut and pasted elsewhere keeps its id, and the threads anchored on it follow it.
 * Ids still held in the doc (a copy, or a second paste) stay off, so no id is ever on two blocks.
 * A drag that moves within the editor keeps its ids: the drop runs this before deleting the source.
 */
export const BlockIdClipboard = Extension.create({
  name: "blockIdClipboard",

  addProseMirrorPlugins() {
    let copied: { json: SliceJSON; key: string } | null = null
    return [
      new Plugin({
        key: new PluginKey("blockIdClipboard"),
        props: {
          transformCopied: (slice) => {
            const json = (slice.toJSON() ?? {}) as SliceJSON
            copied = { json, key: withoutBlockIds(json) }
            return slice
          },
          transformPasted: (slice, view, plain) => {
            if (view.dragging?.move && view.dragging.slice === slice) return slice
            if (plain || !copied || withoutBlockIds((slice.toJSON() ?? {}) as SliceJSON) !== copied.key) return slice
            const held = blockIdsIn(view.state.doc)
            const restored = {
              ...copied.json,
              content: mapNodes(copied.json.content, (attrs) =>
                typeof attrs.blockId === "string" && held.has(attrs.blockId) ? { ...attrs, blockId: null } : attrs
              ),
            }
            return Slice.fromJSON(view.state.schema, restored)
          },
        },
      }),
    ]
  },
})
