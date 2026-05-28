import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoEmbedCardBody } from "@/components/memo-embed/card-body"
import type { MemoEmbedAttrs } from "./memo-embed-extension"

/**
 * In-composer memo-embed card (TipTap NodeView). Resolves the live memo from
 * the detail API and renders the gold-accent card. The body / status rendering
 * is shared with `MemoEmbedBlock` (the markdown-renderer counterpart) via
 * `MemoEmbedCardBody`; this file owns only the NodeView frame, the trailing
 * remove button, and selection highlighting.
 */
export function MemoEmbedView({ node, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as MemoEmbedAttrs
  const source = useMemoEmbedSource(attrs.memoId)
  // Touch devices have no hover state, so always show the remove control on
  // mobile; on desktop expose it via hover OR keyboard focus.
  const isMobile = useIsMobile()

  const removeButton = (
    <button
      type="button"
      onClick={deleteNode}
      className={cn(
        // 24x24 minimum tap target (p-1 + h-4 icon) for WCAG 2.1 AA on touch.
        "shrink-0 rounded-sm p-1 text-muted-foreground transition-opacity hover:text-foreground",
        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        isMobile ? "opacity-100" : "opacity-0 group-hover/memo-embed:opacity-100"
      )}
      aria-label="Remove memo"
    >
      <X className="h-4 w-4" />
    </button>
  )

  return (
    <NodeViewWrapper
      className={cn(
        "my-1 rounded-md border border-border border-l-2 border-l-primary/70 bg-card px-3 py-2 text-sm select-none",
        "group/memo-embed",
        selected && "ring-2 ring-primary/30"
      )}
      data-type="memo-embed"
    >
      <MemoEmbedCardBody source={source} fallbackTitle={attrs.title ?? ""} trailing={removeButton} />
    </NodeViewWrapper>
  )
}
