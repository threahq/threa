import { useEffect } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoChip } from "@/components/memo-embed/memo-chip"
import type { MemoEmbedAttrs } from "./memo-embed-extension"
import { stampNodeAttrs } from "./stamp-node-attrs"

/**
 * In-composer memo-embed chip (TipTap NodeView). Resolves the live memo from
 * the detail API and renders the shared inline `MemoChip`. When the node was
 * inserted without a cached title (e.g. pasted memo link), the resolved title
 * is written back to the node so serialization carries a real label instead of
 * the generic "Memo" fallback.
 */
export function MemoEmbedView({ node, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as MemoEmbedAttrs
  const source = useMemoEmbedSource(attrs.memoId)

  const resolvedTitle = source.status === "resolved" ? source.title : null

  useEffect(() => {
    if (resolvedTitle && !attrs.title) stampNodeAttrs({ editor, getPos }, "memoEmbed", { title: resolvedTitle })
  }, [resolvedTitle, attrs.title, editor, getPos])

  return (
    <NodeViewWrapper as="span" data-type="memo-embed">
      <MemoChip label={resolvedTitle || attrs.title || "Memo"} />
    </NodeViewWrapper>
  )
}
