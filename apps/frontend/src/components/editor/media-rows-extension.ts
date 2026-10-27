import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { mediaReferenceDisplay } from "./attachment-reference-extension"

const MEDIA_ROW_MAX_COLUMNS = 3

const MediaRowsPluginKey = new PluginKey<DecorationSet>("mediaRows")

interface MediaRowSpec {
  mediaColumns: number
}

function isRowMedia(node: ProseMirrorNode): boolean {
  return mediaReferenceDisplay(node, { videos: true }) === "inline" && node.attrs.status !== "error"
}

/**
 * Rendered images and videos that follow one another with only spaces between them share a row, up to three across;
 * one standing alone fills the width. Anything else in the line ends the row.
 */
export function mediaRowDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true
    let row: Array<{ from: number; to: number }> = []
    const endRow = () => {
      const columns = Math.min(row.length, MEDIA_ROW_MAX_COLUMNS)
      const spec: MediaRowSpec = { mediaColumns: columns }
      // The width goes on the node view's host, the only box whose percentage resolves against the line rather than
      // a shrink-wrapped parent. The spaces between media sit in the row too, so each item leaves room for one.
      const attrs = { style: `width: calc((100% - ${columns} * 0.5rem) / ${columns}); vertical-align: top` }
      for (const { from, to } of row) decorations.push(Decoration.node(from, to, attrs, spec))
      row = []
    }
    block.forEach((child, offset) => {
      const from = blockPos + 1 + offset
      if (isRowMedia(child)) row.push({ from, to: from + child.nodeSize })
      else if (!child.isText || child.text?.trim()) endRow()
    })
    endRow()
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** How many columns the row holding this media node splits into; null when the node is not laid out in a row. */
export function mediaRowColumns(decorations: readonly Decoration[]): number | null {
  for (const decoration of decorations) {
    const columns = (decoration.spec as Partial<MediaRowSpec>).mediaColumns
    if (columns) return columns
  }
  return null
}

/** A decoration, not node-view state: a node view redraws only when its own node changes, not when a neighbour joins. */
export const MediaRows = Extension.create({
  name: "mediaRows",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: MediaRowsPluginKey,
        state: {
          init: (_, state) => mediaRowDecorations(state.doc),
          apply: (tr, decorations) => (tr.docChanged ? mediaRowDecorations(tr.doc) : decorations),
        },
        props: {
          decorations: (state) => MediaRowsPluginKey.getState(state),
        },
      }),
    ]
  },
})
