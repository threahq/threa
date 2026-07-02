import { MessageSquareReply } from "lucide-react"
import type { StreamContextRef } from "@threa/types"
import { useCachedStreamContextBag } from "@/hooks/use-cached-stream-context-bag"
import { formatContextRefLabel } from "@/lib/context-bag/format-label"
import { buildContextRefSourceHref } from "@/lib/context-bag/source-link"
import { AttachmentPill } from "./attachment-pill"

interface MessageContextBadgeProps {
  workspaceId: string
  /** Stream the message lives in. Used to look up the stream's cached bag. */
  streamId: string
}

/**
 * Renders the stream's context-bag attachment as inline pills anchored to
 * the first message of a bag-attached scratchpad.
 *
 * Routes through the shared `<AttachmentPill>` primitive (the same one used
 * by `<AttachmentList>` file cards and `<ContextRefStrip>` composer chips)
 * so files + context-refs read as one row of "things attached to this
 * message" at identical metrics, palette, and link/remove affordances.
 *
 * Reads synchronously from `useCachedStreamContextBag` (IDB-backed) so the
 * pill is present on first paint — matches how file attachments live on
 * the message payload and render without a fetch.
 *
 * Each pill deep-links to the source thread, anchored to the originating
 * message via `?m=<messageId>` when set.
 */
export function MessageContextBadge({ workspaceId, streamId }: MessageContextBadgeProps) {
  const data = useCachedStreamContextBag(workspaceId, streamId)
  const refs = data.refs
  if (refs.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {refs.map((ref: StreamContextRef) => {
        const label = formatContextRefLabel({
          kind: ref.kind,
          slug: ref.source.slug,
          displayName: ref.source.displayName,
          streamType: ref.source.type,
          itemCount: ref.source.itemCount,
          fromMessageId: ref.fromMessageId,
          toMessageId: ref.toMessageId,
        })
        const href = buildContextRefSourceHref({
          workspaceId,
          sourceStreamId: ref.streamId,
          conversationId: ref.conversationId,
          originMessageId: ref.originMessageId,
        })
        const isConversation = ref.kind === "conversation"
        return (
          <AttachmentPill
            key={`${ref.kind}|${ref.streamId}|${ref.conversationId ?? ""}|${ref.fromMessageId ?? ""}|${ref.toMessageId ?? ""}`}
            icon={MessageSquareReply}
            label={label}
            labelMaxWidth="max-w-[220px]"
            href={href}
            tooltip={isConversation ? "Click to open the source conversation" : "Click to open the source thread"}
          />
        )
      })}
    </div>
  )
}
