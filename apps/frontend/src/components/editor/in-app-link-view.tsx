import { useEffect } from "react"
import { MessageSquare, MessagesSquare, Globe, Lock } from "lucide-react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { useParams } from "react-router-dom"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import type { InAppLinkAttrs } from "./in-app-link-extension"

/**
 * In-composer chip for an in-app link (TipTap NodeView). A conversation link has
 * no `streamId` (no `/s/:id` permalink), so it resolves by URL through the
 * conversation resolver; a stream/message link resolves its live name through the
 * shared `useInAppLinkChip`. Split into two sub-views so each calls exactly the
 * hook its kind needs (a NodeView can't branch its hooks) — the dispatcher picks
 * by the presence of `streamId`.
 */
export function InAppLinkView({ node, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as InAppLinkAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()

  if (!attrs.streamId) {
    return <ConversationChipView attrs={attrs} workspaceId={workspaceId ?? ""} updateAttributes={updateAttributes} />
  }
  return <StreamMessageChipView attrs={attrs} workspaceId={workspaceId ?? ""} updateAttributes={updateAttributes} />
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
  updateAttributes,
}: {
  attrs: InAppLinkAttrs
  workspaceId: string
  updateAttributes: (attrs: Record<string, unknown>) => void
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
  // (pasted link). A user/compose-cached name is left as-is so the write-back
  // doesn't churn the undo history on every render.
  useEffect(() => {
    if (resolvedName && !attrs.name) {
      updateAttributes({ name: resolvedName })
    }
  }, [resolvedName, attrs.name, updateAttributes])

  const pendingIcon = attrs.messageId ? MessageSquare : undefined
  const icon = state.status === "pending" ? pendingIcon : state.icon
  const label = state.status === "pending" ? attrs.name || "Link" : state.label
  const prefix = state.status === "resolved" ? state.prefix : undefined

  return (
    <NodeViewWrapper as="span" data-type="in-app-link">
      <InAppLinkChip icon={icon} prefix={prefix} label={label} />
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
  updateAttributes,
}: {
  attrs: InAppLinkAttrs
  workspaceId: string
  updateAttributes: (attrs: Record<string, unknown>) => void
}) {
  const { data } = useResolvedInAppLink(workspaceId, undefined, attrs.url, true)

  const resolvedName = data?.kind === "conversation" && data.accessTier === "full" ? (data.topicSummary ?? null) : null

  useEffect(() => {
    if (resolvedName && !attrs.name) {
      updateAttributes({ name: resolvedName })
    }
  }, [resolvedName, attrs.name, updateAttributes])

  let icon = MessagesSquare
  let label = attrs.name || "Conversation"
  if (data?.accessTier === "cross_workspace") {
    icon = Globe
    label = "Another workspace"
  } else if (data?.accessTier === "private") {
    icon = Lock
    label = "Private conversation"
  } else if (resolvedName) {
    label = resolvedName
  }

  return (
    <NodeViewWrapper as="span" data-type="in-app-link">
      <InAppLinkChip icon={icon} label={label} />
    </NodeViewWrapper>
  )
}
