import { type MouseEvent } from "react"
import { MessageSquare } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { resolveInternalAppPath } from "@/lib/internal-url"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import { InAppLinkChip } from "./in-app-link-chip"

/**
 * Posted-message rendering of an in-app stream/message link: the same chip the
 * composer shows, but navigable. Swapped in for the plain underlined link by
 * `MarkdownLink` when the href classifies as an in-app stream/message URL, so
 * old and new messages alike render the link as a compact named text chip
 * instead of a raw URL. Resolution goes through the shared `useInAppLinkChip`
 * (local cache → access-tiered backend); a message link's rich preview (author
 * face, snippet) renders in the below-message card, not here.
 */
export function InAppLinkInline({
  href,
  workspaceId,
  streamId,
  messageId,
  fallbackLabel,
}: {
  href: string
  workspaceId: string
  streamId: string
  messageId: string | null
  fallbackLabel: string
}) {
  const navigate = useNavigate()
  const state = useInAppLinkChip({ workspaceId, streamId, messageId, isMessage: Boolean(messageId), url: href })

  // A message keeps its glyph while pending (the label is the baked text, already
  // correct) so resolving never swaps the leading icon; a stream pending stays
  // glyphless and resolves its name synchronously from cache.
  const pendingIcon = messageId ? MessageSquare : undefined
  const icon = state.status === "pending" ? pendingIcon : state.icon
  const label = state.status === "pending" ? fallbackLabel || "Link" : state.label
  const prefix = state.status === "resolved" ? state.prefix : undefined
  const messageParts = state.status === "resolved" ? state.messageParts : undefined
  const chip = <InAppLinkChip icon={icon} prefix={prefix} label={label} messageParts={messageParts} />

  const internalPath = resolveInternalAppPath(href)
  if (!internalPath) return chip

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(internalPath)
  }

  return (
    <a href={href} onClick={handleClick} className="no-underline">
      {chip}
    </a>
  )
}
