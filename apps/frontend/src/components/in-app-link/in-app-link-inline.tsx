import { type MouseEvent } from "react"
import { MessageSquare, MessagesSquare, Globe, Lock, TerminalSquare } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { resolveInternalAppPath } from "@/lib/internal-url"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { InAppLinkChip } from "./in-app-link-chip"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import { useWorkspaceStreams } from "@/stores/workspace-store"

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
  const chip = <InAppLinkChip icon={icon} prefix={prefix} label={label} />

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

/**
 * Posted-message rendering of an in-app conversation link as a compact chip
 * (`💬 {topicSummary}`), the inline sibling of the below-message conversation
 * card. Resolves its title through the same access-tiered resolver the card uses
 * (shared query cache), so the chip and card never round-trip twice. A restricted
 * tier (cross-workspace / private) renders a non-navigable placeholder chip; a
 * cold resolve shows the generic "Conversation" label behind the same glyph, so
 * resolving only swaps the text, never the icon (INV-21).
 */
export function ConversationLinkInline({ href, workspaceId }: { href: string; workspaceId: string }) {
  const navigate = useNavigate()
  const { data } = useResolvedInAppLink(workspaceId, undefined, href, true)
  const streams = useWorkspaceStreams(workspaceId)

  if (data?.accessTier === "cross_workspace") {
    return <InAppLinkChip icon={Globe} label="Another workspace" />
  }
  if (data?.accessTier === "private") {
    return <InAppLinkChip icon={Lock} label="Private conversation" />
  }

  const label =
    data?.kind === "conversation"
      ? effectiveConversationTitle(
          { streamId: data.streamId ?? "", topicSummary: data.topicSummary ?? null },
          streams.find((stream) => stream.id === data.streamId)
        ) || "Conversation"
      : "Conversation"
  const chip = <InAppLinkChip icon={MessagesSquare} label={label} />

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

/**
 * Posted-message rendering of an in-app delegation link as a compact chip
 * (`▢ {title}`), the inline sibling of the below-message delegation card.
 * Resolves its title through the same access-tiered resolver the card uses
 * (shared query cache), so the chip and card never round-trip twice. A restricted
 * tier (cross-workspace / private) renders a non-navigable placeholder chip; a
 * cold resolve shows the generic "Delegation" label behind the same glyph, so
 * resolving only swaps the text, never the icon (INV-21).
 */
export function DelegationLinkInline({ href, workspaceId }: { href: string; workspaceId: string }) {
  const navigate = useNavigate()
  const { data } = useResolvedInAppLink(workspaceId, undefined, href, true)

  if (data?.accessTier === "cross_workspace") {
    return <InAppLinkChip icon={Globe} label="Another workspace" />
  }
  if (data?.accessTier === "private") {
    return <InAppLinkChip icon={Lock} label="Private delegation" />
  }

  const label = (data?.kind === "delegation" && data.title) || "Delegation"
  const chip = <InAppLinkChip icon={TerminalSquare} label={label} />

  // Once resolved, navigate straight to the card's timeline row — the same
  // deep-link the preview card uses — instead of bouncing through the
  // /delegations/:id redirect (route loader + an uncached fetch). The
  // canonical href stays on the anchor for copy/open-in-new-tab.
  let internalPath = resolveInternalAppPath(href)
  if (data?.kind === "delegation" && data.streamId) {
    const base = `/w/${workspaceId}/s/${data.streamId}`
    internalPath = data.createdEventId ? `${base}?m=${data.createdEventId}` : base
  }
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
