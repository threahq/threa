import type { NodeViewProps } from "@tiptap/react"
import { ySyncPluginKey } from "y-prosemirror"
import type { DisplayStamp, DisplayStampedNode } from "@/lib/display-stamps"

/**
 * Writes resolved display data onto a node view's node outside undo history,
 * so one undo still reverts the edit that inserted the node.
 */
export function stampNodeAttrs<T extends DisplayStampedNode>(
  { editor, getPos }: Pick<NodeViewProps, "editor" | "getPos">,
  type: T,
  attrs: DisplayStamp<T>
): void {
  // A shared doc is never mutated by rendering it.
  if (ySyncPluginKey.getState(editor.state)) return
  const pos = getPos()
  if (typeof pos !== "number") return
  const current = editor.state.doc.nodeAt(pos)
  if (current?.type.name !== type) return
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }).setMeta("addToHistory", false)
  )
}
