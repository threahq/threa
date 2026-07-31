import { useEffect } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoChip } from "@/components/memo-embed/memo-chip"
import { memoEmbedSummaryFromResolved } from "@/lib/memo-embed-summary"
import type { MemoEmbedAttrs } from "./memo-embed-extension"

/**
 * In-composer memo-embed chip (TipTap NodeView). Resolves the live memo from
 * the detail API and renders the shared inline `MemoChip`.
 *
 * A node inserted through the picker already carries its title and card content.
 * A node from a pasted memo link carries neither, so both are written back onto
 * the node once resolved — the card content because it has to ride inside the
 * body to survive a sealed stream or an offline send, and the title so
 * serialization carries a real label instead of the generic "Memo" fallback.
 * Fetching here is fine: this is the composer, not the stream.
 */
export function MemoEmbedView({ node, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as MemoEmbedAttrs
  const source = useMemoEmbedSource(attrs.memoId)

  const resolved = source.status === "resolved" ? source : null
  const needsTitle = !attrs.title
  const needsSummary = !attrs.summary

  // Stamp only what the node is missing, so a user-cached title isn't fought
  // over and the undo history doesn't churn on every render.
  useEffect(() => {
    if (!resolved) return
    if (!needsTitle && !needsSummary) return
    updateAttributes({
      ...(needsTitle && { title: resolved.title }),
      ...(needsSummary && { summary: memoEmbedSummaryFromResolved(attrs.memoId, resolved) }),
    })
  }, [resolved, needsTitle, needsSummary, attrs.memoId, updateAttributes])

  return (
    <NodeViewWrapper as="span" data-type="memo-embed">
      <MemoChip label={resolved?.title || attrs.title || "Memo"} />
    </NodeViewWrapper>
  )
}
