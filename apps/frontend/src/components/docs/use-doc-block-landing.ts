import { useEffect } from "react"
import type { Editor } from "@tiptap/react"
import { subscribeBlockFocus, takeBlockFocus } from "@/lib/docs/block-focus"

/** Lands the doc on the block a gesture asked it to open on, now or while it stays open. */
export function useDocBlockLanding(editor: Editor | null, docId: string): void {
  useEffect(() => {
    if (!editor) return
    const land = (blockId: string) => {
      if (!editor.isDestroyed) editor.commands.landOnBlock(blockId)
    }
    const pending = takeBlockFocus(docId)
    if (pending) land(pending)
    return subscribeBlockFocus(docId, land)
  }, [editor, docId])
}
