import { type ComponentType } from "react"
import { Brain, Lock, Globe, Link2 } from "lucide-react"
import { AttachmentPill } from "./attachment-pill"
import { useResolvedInAppLink } from "@/components/timeline/in-app-link-preview-card"
import { useInAppLinkChip } from "@/hooks/use-in-app-link-chip"
import type { DraftLinkRef } from "@/lib/in-app-links"

/**
 * One compact chip for a link in the draft. Stealing the attachment-pill
 * semantics keeps several links from eating the screen (a full preview card per
 * link buries the composer on mobile). In-app stream/message links resolve their
 * name and icon from the local workspace cache — the canonical name source
 * (frontend CLAUDE.md) — which also renders correctly for any stream the viewer
 * can see without a round-trip; the access-tiered backend resolve is the
 * fallback only when the stream isn't cached (no access / cross-workspace /
 * thread). Memo links resolve via the backend; web links chip their host.
 *
 * Non-navigable on purpose: clicking must not abandon the draft mid-compose.
 */
export function ComposerLinkChip({
  link,
  workspaceId,
  onDismiss,
}: {
  link: DraftLinkRef
  workspaceId: string
  onDismiss: (url: string) => void
}) {
  const remove = () => onDismiss(link.url)

  if (link.kind === "web") {
    return (
      <AttachmentPill icon={Globe} label={link.host} tooltip={link.url} onRemove={remove} removeLabel="Hide link" />
    )
  }

  if (link.kind === "memo") {
    return <MemoChip workspaceId={workspaceId} url={link.url} onRemove={remove} />
  }

  return (
    <StreamChip
      workspaceId={workspaceId}
      streamId={link.streamId}
      url={link.url}
      isMessage={link.kind === "message"}
      onRemove={remove}
    />
  )
}

function StreamChip({
  workspaceId,
  streamId,
  url,
  isMessage,
  onRemove,
}: {
  workspaceId: string
  streamId: string
  url: string
  isMessage: boolean
  onRemove: () => void
}) {
  const state = useInAppLinkChip({ workspaceId, streamId, isMessage, url })

  if (state.status === "pending") return <PendingChip onRemove={onRemove} />
  if (state.status === "restricted") {
    return <RestrictedChip icon={state.icon} label={state.label} onRemove={onRemove} />
  }
  return <AttachmentPill icon={state.icon} label={state.label} onRemove={onRemove} removeLabel="Hide link" />
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
