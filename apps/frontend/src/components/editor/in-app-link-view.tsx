import { useCallback, useEffect } from "react"
import { MessageSquare, MessagesSquare, Globe, Lock } from "lucide-react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useParams } from "react-router-dom"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { useConversationTitleDetails } from "@/hooks/use-conversation-title"
import type { InAppLinkAttrs } from "./in-app-link-extension"
import { cn } from "@/lib/utils"
import { conversationChipLabel } from "./conversation-chip-label"
import { useReferenceExposed } from "./reference-audience-context"
import { AUDIENCE_TONE } from "./reference-audience-tone"
import { stampNodeAttrs } from "./stamp-node-attrs"

/**
 * In-composer chip for an in-app link (TipTap NodeView). A conversation link has
 * no `streamId` (no `/s/:id` permalink), so it resolves by URL through the
 * conversation resolver; a stream/message link resolves its live name through the
 * shared `useInAppLinkChip`. Split into two sub-views so each calls exactly the
 * hook its kind needs (a NodeView can't branch its hooks) — the dispatcher picks
 * by the presence of `streamId`.
 */
export function InAppLinkView({ node, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as InAppLinkAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const stampName = useCallback((name: string) => stampNodeAttrs({ editor, getPos }, { name }), [editor, getPos])

  if (!attrs.streamId) {
    return <ConversationChipView attrs={attrs} workspaceId={workspaceId ?? ""} stampName={stampName} />
  }
  return <StreamMessageChipView attrs={attrs} workspaceId={workspaceId ?? ""} stampName={stampName} />
}

/**
 * Resolves the live name (local cache → access-tiered backend) via the shared
 * `useInAppLinkChip`. When the node was inserted without a cached name (pasted
 * link), the resolved name is written back so serialization carries a real label
 * instead of the generic fallback.
 */
function StreamMessageChipView({
  attrs,
  workspaceId,
  stampName,
}: {
  attrs: InAppLinkAttrs
  workspaceId: string
  stampName: (name: string) => void
}) {
  const state = useInAppLinkChip({
    workspaceId,
    streamId: attrs.streamId ?? "",
    messageId: attrs.messageId,
    isMessage: Boolean(attrs.messageId),
    url: attrs.url,
  })

  const resolvedName = state.status === "resolved" ? state.label : null

  // Stamp the resolved name onto the node only when it was inserted without one
  // (pasted link). A user/compose-cached name is left as-is.
  useEffect(() => {
    if (resolvedName && !attrs.name) stampName(resolvedName)
  }, [resolvedName, attrs.name, stampName])

  const exposed = useReferenceExposed(attrs.streamId)
  const pendingIcon = attrs.messageId ? MessageSquare : undefined
  const icon = state.status === "pending" ? pendingIcon : state.icon
  const label = state.status === "pending" ? attrs.name || "Link" : state.label
  const prefix = state.status === "resolved" ? state.prefix : undefined
  // The lock takes the place of the chip's own glyph (icon or `#`), so the chip keeps its size.
  const tone = AUDIENCE_TONE.unreachable
  const exposedPrefix = prefix && <tone.icon aria-hidden="true" className="inline h-3 w-3 align-[-0.1em]" />

  return (
    <NodeViewWrapper as="span" data-type="in-app-link">
      <InAppLinkChip
        icon={exposed ? tone.icon : icon}
        prefix={exposed ? exposedPrefix : prefix}
        label={label}
        className={exposed ? cn(tone.surface, tone.text) : undefined}
      />
    </NodeViewWrapper>
  )
}

/**
 * Conversation chip: resolves the topic through the access-tiered resolver
 * (shared cache with the below-message card and the timeline chip). A restricted
 * tier renders a non-navigable placeholder the way an inaccessible channel does;
 * the resolved topic is stamped back so serialization carries a real label.
 */
function ConversationChipView({
  attrs,
  workspaceId,
  stampName,
}: {
  attrs: InAppLinkAttrs
  workspaceId: string
  stampName: (name: string) => void
}) {
  const { data } = useResolvedInAppLink(workspaceId, undefined, attrs.url, true)
  const conversation = data?.kind === "conversation" ? data : null
  const titleDetails = useConversationTitleDetails(workspaceId, {
    streamId: conversation?.streamId ?? "",
    topicSummary: conversation?.topicSummary ?? null,
  })
  const resolvedName = conversation?.accessTier === "full" ? titleDetails.title : null

  useEffect(() => {
    if (resolvedName && !attrs.name) stampName(resolvedName)
  }, [resolvedName, attrs.name, stampName])

  let icon = MessagesSquare
  if (data?.accessTier === "cross_workspace") icon = Globe
  else if (data?.accessTier === "private" || (conversation?.accessTier === "full" && titleDetails.isE2e)) icon = Lock
  const label = conversationChipLabel({
    accessTier: data?.accessTier,
    resolvedName,
    isE2e: titleDetails.isE2e,
    pending: titleDetails.pending,
  })

  return (
    <NodeViewWrapper as="span" data-type="in-app-link">
      <InAppLinkChip icon={icon} label={label} />
    </NodeViewWrapper>
  )
}
