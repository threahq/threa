import { useEffect } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoChip } from "@/components/memo-embed/memo-chip"
import type { MemoEmbedAttrs } from "./memo-embed-extension"

/**
 * In-composer memo-embed chip (TipTap NodeView). Resolves the live memo from
 * the detail API and renders the shared inline `MemoChip`. When the node was
 * inserted without a cached title (e.g. pasted memo link), the resolved title
 * is written back to the node so serialization carries a real label instead of
 * the generic "Memo" fallback.
 */
export function MemoEmbedView({ node, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as MemoEmbedAttrs
  const source = useMemoEmbedSource(attrs.memoId)

  const resolvedTitle = source.status === "resolved" ? source.title : null

  // Stamp the resolved title onto the node only when it was inserted without
  // one (pasted memo link). A user-cached title is left as-is so the write-back
  // doesn't fight the editor or churn the undo history on every render.
  useEffect(() => {
    if (resolvedTitle && !attrs.title) {
      updateAttributes({ title: resolvedTitle })
    }
  }, [resolvedTitle, attrs.title, updateAttributes])

  return (
    <NodeViewWrapper as="span" data-type="memo-embed">
      <MemoChip label={resolvedTitle || attrs.title || "Memo"} />
    </NodeViewWrapper>
  )
}
