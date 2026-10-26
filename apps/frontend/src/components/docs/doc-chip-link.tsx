import type { MouseEvent } from "react"
import { useParams, Link } from "react-router-dom"
import { useOptionalPanel } from "@/contexts"
import { requestBlockFocus } from "@/lib/docs/block-focus"
import { DocChip } from "./doc-chip"
import { useLiveDocTitle } from "./use-live-doc-title"

interface DocChipLinkProps {
  docId: string
  blockId?: string | null
  /** The link text the pointer was sent with. */
  fallbackTitle: string
}

/** A `doc:` pointer in rendered content: the chip, opening the doc in a pane beside, or as a page outside one. */
export function DocChipLink({ docId, blockId, fallbackTitle }: DocChipLinkProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const panel = useOptionalPanel()
  const { label } = useLiveDocTitle(workspaceId, docId, fallbackTitle)
  const chip = <DocChip label={label} />
  if (!workspaceId) return chip

  const handleClick = (event: MouseEvent) => {
    if (!blockId || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    requestBlockFocus(docId, blockId)
  }

  return (
    <Link
      to={panel ? panel.getPanelUrl(docId) : `/w/${workspaceId}/s/${docId}`}
      onClick={handleClick}
      className="no-underline"
    >
      {chip}
    </Link>
  )
}
