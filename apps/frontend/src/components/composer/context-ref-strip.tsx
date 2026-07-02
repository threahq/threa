import { Loader2, MessageSquareReply, AlertCircle } from "lucide-react"
import { useStreamContextBag } from "@/hooks/use-stream-context-bag"
import { formatContextRefLabel } from "@/lib/context-bag/format-label"
import { buildContextRefSourceHref } from "@/lib/context-bag/source-link"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { AttachmentPill, type AttachmentPillStatus } from "./attachment-pill"

interface ContextRefStripProps {
  workspaceId: string
  /** Stream the strip lives in. Used to look up source-stream metadata for label rendering. */
  streamId: string
  /**
   * Sidecar refs from the live draft. The strip renders only when this list
   * is non-empty — once the draft is cleared on first send, the chip moves
   * into the timeline as a `<MessageContextBadge>` on the first message.
   */
  draftRefs?: DraftContextRef[]
}

const STATUS_MAP: Record<DraftContextRef["status"], AttachmentPillStatus> = {
  pending: "pending",
  ready: "default",
  inline: "default",
  error: "error",
}

const STATUS_ICON: Record<DraftContextRef["status"], typeof MessageSquareReply> = {
  pending: Loader2,
  ready: MessageSquareReply,
  inline: MessageSquareReply,
  error: AlertCircle,
}

// Composite identity tuple shared by the pre-send draft refs and the
// server-resolved bag refs. Keep it at module scope so the React `key` and
// the server-by-key Map lookup can't drift on shape (`refKind` vs `kind`).
function refKey(r: {
  refKind?: string
  kind?: string
  streamId: string
  conversationId?: string | null
  fromMessageId?: string | null
  toMessageId?: string | null
}): string {
  return `${r.refKind ?? r.kind}|${r.streamId}|${r.conversationId ?? ""}|${r.fromMessageId ?? ""}|${r.toMessageId ?? ""}`
}

/**
 * Inline strip rendered above the composer for any context refs attached
 * to the active draft. Uses the same `<AttachmentPill>` primitive as
 * `<PendingAttachments>` so context refs and uploaded files read alike.
 * Renders nothing when the draft has no refs. Each pill links to the
 * source thread, deep-linked to a specific message when `fromMessageId`
 * is set.
 */
export function ContextRefStrip({ workspaceId, streamId, draftRefs }: ContextRefStripProps) {
  const hasDraftRefs = Boolean(draftRefs && draftRefs.length > 0)
  // Bootstrap-hydrated, so this is synchronous for any stream whose
  // bootstrap has already loaded — no fetch wait, no layout shift.
  const { data } = useStreamContextBag(workspaceId, hasDraftRefs ? streamId : null)

  if (!hasDraftRefs || !draftRefs) return null

  // Bag refs may share a streamId with different `fromMessageId` /
  // `toMessageId` anchors, so a streamId-only Map would silently drop one
  // of them — `refKey` (module scope) builds the composite identity tuple.
  const serverByKey = new Map((data?.refs ?? []).map((r) => [refKey(r), r]))

  return (
    <>
      {draftRefs.map((ref) => {
        const server = serverByKey.get(refKey(ref))
        const label = formatContextRefLabel({
          kind: ref.refKind,
          slug: server?.source.slug ?? null,
          displayName: server?.source.displayName ?? null,
          streamType: server?.source.type ?? null,
          itemCount: server?.source.itemCount ?? null,
          fromMessageId: ref.fromMessageId,
          toMessageId: ref.toMessageId,
        })
        const tooltip =
          ref.errorMessage ?? (ref.status === "pending" ? "Preparing context…" : "Click to open the source thread")
        return (
          <AttachmentPill
            key={refKey(ref)}
            icon={STATUS_ICON[ref.status]}
            label={label}
            status={STATUS_MAP[ref.status]}
            tooltip={tooltip}
            href={
              ref.status === "pending"
                ? undefined
                : buildContextRefSourceHref({
                    workspaceId,
                    sourceStreamId: ref.streamId,
                    conversationId: ref.conversationId,
                    originMessageId: ref.originMessageId,
                  })
            }
            labelMaxWidth="max-w-[200px]"
          />
        )
      })}
    </>
  )
}
