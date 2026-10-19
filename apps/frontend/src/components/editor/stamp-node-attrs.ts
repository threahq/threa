import type { NodeViewProps } from "@tiptap/react"

/**
 * Writes resolved display data onto a node view's node outside undo history,
 * so one undo still reverts the edit that inserted the node.
 */
export function stampNodeAttrs(
  { editor, getPos }: Pick<NodeViewProps, "editor" | "getPos">,
  attrs: Record<string, unknown>
): void {
  const pos = getPos()
  if (typeof pos !== "number") return
  const current = editor.state.doc.nodeAt(pos)
  if (!current) return
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }).setMeta("addToHistory", false)
  )
}
