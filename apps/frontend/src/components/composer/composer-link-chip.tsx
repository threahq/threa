import { type ComponentType } from "react"
import { Brain, Lock, Globe, Link2, MessagesSquare } from "lucide-react"
import { AttachmentPill } from "./attachment-pill"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import type { BelowRowDraftLink } from "@/lib/in-app-links"

/**
 * One compact chip for a below-row draft link — web, memo, or conversation.
 * Stream/message in-app links never reach here: they render as an inline chip in
 * the draft body (`ComposerLinkPreviews` filters them via `isBelowRowDraftLink`),
 * matching the posted message (#1103). Stealing the attachment-pill semantics
 * keeps several links from eating the screen (a full preview card per link buries
 * the composer on mobile). Memo/conversation links resolve via the backend; web
 * links chip their host.
 *
 * Non-navigable on purpose: clicking must not abandon the draft mid-compose.
 */
export function ComposerLinkChip({
  link,
  workspaceId,
  onDismiss,
}: {
  link: BelowRowDraftLink
  workspaceId: string
  onDismiss: (url: string) => void
}) {
  const remove = () => onDismiss(link.url)

  if (link.kind === "memo") {
    return <MemoChip workspaceId={workspaceId} url={link.url} onRemove={remove} />
  }

  if (link.kind === "conversation") {
    return <ConversationChip workspaceId={workspaceId} url={link.url} onRemove={remove} />
  }

  return <AttachmentPill icon={Globe} label={link.host} tooltip={link.url} onRemove={remove} removeLabel="Hide link" />
}

function ConversationChip({ workspaceId, url, onRemove }: { workspaceId: string; url: string; onRemove: () => void }) {
  const { data, loading } = useResolvedInAppLink(workspaceId, undefined, url, true)

  if (loading) return <PendingChip onRemove={onRemove} />
  if (data?.accessTier === "cross_workspace") {
    return <RestrictedChip icon={Globe} label="Another workspace" onRemove={onRemove} />
  }
  if (data?.accessTier === "private") {
    return <RestrictedChip icon={Lock} label="Private conversation" onRemove={onRemove} />
  }

  const title = (data?.kind === "conversation" && data.topicSummary) || "Conversation"
  return <AttachmentPill icon={MessagesSquare} label={title} onRemove={onRemove} removeLabel="Hide link" />
}

function MemoChip({ workspaceId, url, onRemove }: { workspaceId: string; url: string; onRemove: () => void }) {
  const { data, loading } = useResolvedInAppLink(workspaceId, undefined, url, true)

  if (loading) return <PendingChip onRemove={onRemove} />
  if (data?.accessTier === "cross_workspace") {
    return <RestrictedChip icon={Globe} label="Another workspace" onRemove={onRemove} />
  }
  if (data?.accessTier === "private") {
    return <RestrictedChip icon={Lock} label="Private memory" onRemove={onRemove} />
  }

  const title = (data?.kind === "memo" && data.title) || "Memory"
  return <AttachmentPill icon={Brain} label={title} onRemove={onRemove} removeLabel="Hide link" />
}

/** A restricted in-app target the viewer can't open — named only by tier, no leak. */
function RestrictedChip({
  icon,
  label,
  onRemove,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  onRemove: () => void
}) {
  return <AttachmentPill icon={icon} label={label} onRemove={onRemove} removeLabel="Hide link" />
}

/** In-flight resolve — dashed/spinning pill so the chip doesn't pop in late (INV-21). */
function PendingChip({ onRemove }: { onRemove: () => void }) {
  return <AttachmentPill icon={Link2} label="Link" status="pending" onRemove={onRemove} removeLabel="Hide link" />
}
