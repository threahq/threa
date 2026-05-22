import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { AlertCircle } from "lucide-react"
import type { ScheduledMessageView } from "@threa/types"
import { cn } from "@/lib/utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import { formatSendCountdown } from "@/lib/dates"
import { useStreamName } from "@/hooks/use-stream-name"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLongPress } from "@/hooks/use-long-press"
import { RelativeTime } from "@/components/relative-time"
import { ScheduledActionDrawer } from "./scheduled-action-drawer"
import { ScheduledActions } from "./scheduled-actions"

interface ScheduledItemProps {
  scheduled: ScheduledMessageView
  workspaceId: string
  onEdit?: (id: string) => void
  onCancel?: (id: string) => void
  onSendNow?: (id: string) => void
}

/**
 * List row for the /scheduled page. Mirrors the SavedItem 3-line layout —
 * stream chip header, message preview, time-until footer — and the
 * hover-reveal action cluster on desktop. On mobile we replace the tiny
 * action icons with a long-press → bottom-sheet drawer (the convention used
 * by the timeline's MessageActionDrawer): tap navigates / opens edit, hold
 * to reveal Send-now / Edit / Cancel.
 *
 * Sent rows behave as links to the live message in its stream; pending and
 * failed rows route the body click into the edit dialog (via onEdit).
 */
export function ScheduledItem({ scheduled, workspaceId, onEdit, onCancel, onSendNow }: ScheduledItemProps) {
  const isMobile = useIsMobile()
  // Always render in the device's local timezone — using a stored
  // `preferences.timezone` would silently disagree with native pickers
  // (which always operate in device-local), so a row scheduled at 07:46
  // in the dialog could appear as 08:46 in the list. Browser-local
  // everywhere keeps display and input consistent.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  // The row may briefly outlive a membership the user no longer has; the
  // "stream" fallback covers that until the failure path catches it.
  const streamName = useStreamName(workspaceId, scheduled.streamId) ?? "stream"

  const preview = useMemo(
    () => stripMarkdownToInline(scheduled.contentMarkdown).trim() || "(empty)",
    [scheduled.contentMarkdown]
  )

  const scheduledFor = useMemo(() => new Date(scheduled.scheduledFor), [scheduled.scheduledFor])
  // Sub-1m collapses to "Sending soon" — see formatSendCountdown for rationale.
  const labelOrSoon = formatSendCountdown(scheduledFor, new Date(), { timezone })

  const isPending = scheduled.status === "pending"
  const isFailed = scheduled.status === "failed"
  const isSent = scheduled.status === "sent"
  const isCancelled = scheduled.status === "cancelled"

  const sentLink =
    isSent && scheduled.sentMessageId ? `/w/${workspaceId}/s/${scheduled.streamId}?m=${scheduled.sentMessageId}` : null

  let verbPrefix = "Sending to"
  if (isSent) verbPrefix = "Sent to"
  else if (isCancelled) verbPrefix = "Cancelled for"

  // Pending uses the future-time formatter ("5m", "Tomorrow 9:00") with sub-1m
  // collapsed to "Sending soon". Sent rows render via the same `<RelativeTime>`
  // component the stream timeline uses so we get "5m ago" / "yesterday 14:30"
  // instead of `formatFutureTime`'s 0m clamp on past instants.
  const pendingLabel = isPending ? labelOrSoon : null

  const [drawerOpen, setDrawerOpen] = useState(false)
  // Long-press only on mobile, only for actionable rows. Sent/cancelled rows
  // have no actions so we don't trap their tap on a deferred timer.
  const longPressEnabled = isMobile && (isPending || isFailed)
  const longPress = useLongPress({
    enabled: longPressEnabled,
    onLongPress: () => setDrawerOpen(true),
  })

  const Content = (
    <>
      <div className="flex items-baseline gap-1.5 text-sm">
        <span className="text-muted-foreground">{verbPrefix}</span>
        <span className="truncate font-medium">{streamName}</span>
        {isFailed && (
          <span className="ml-1 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-destructive">
            <AlertCircle className="h-3 w-3" />
            failed
          </span>
        )}
      </div>

      <p className={cn("mt-0.5 truncate text-xs text-muted-foreground", isFailed && "italic")}>
        {isFailed && scheduled.lastError ? scheduled.lastError : preview}
      </p>

      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground/60">
        {pendingLabel && <span className="tabular-nums">{pendingLabel}</span>}
        {isSent && (
          <span className="inline-flex items-center gap-1">
            <span>Sent</span>
            <RelativeTime date={scheduled.statusChangedAt} terse />
          </span>
        )}
        {scheduled.attachmentIds.length > 0 && (
          <span>
            {scheduled.attachmentIds.length} attachment{scheduled.attachmentIds.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </>
  )

  // Tap behavior:
  //   sent  → link to live message
  //   pending/failed → edit dialog (onEdit handler)
  //   cancelled → no-op (read-only row)
  const handleTap = () => {
    if (sentLink || isCancelled) return
    if (onEdit && (isPending || isFailed)) onEdit(scheduled.id)
  }

  return (
    <>
      <div
        className={cn(
          "group flex items-start gap-3 border-b border-border/50 px-4 py-3 hover:bg-muted/40",
          isFailed && "border-l-4 border-l-destructive",
          longPress.isPressed && "bg-muted/40"
        )}
        onTouchStart={longPress.handlers.onTouchStart}
        onTouchEnd={longPress.handlers.onTouchEnd}
        onTouchMove={longPress.handlers.onTouchMove}
        onContextMenu={longPress.handlers.onContextMenu}
      >
        {sentLink ? (
          <Link to={sentLink} className="min-w-0 flex-1">
            {Content}
          </Link>
        ) : (
          <button
            type="button"
            onClick={handleTap}
            className="min-w-0 flex-1 text-left focus:outline-none disabled:cursor-default"
            disabled={isCancelled || (!isPending && !isFailed)}
          >
            {Content}
          </button>
        )}

        {/* Desktop hover-reveal actions. Hidden on mobile — long-press handles
            the drawer, no tiny tap targets. The wrapper owns the
            opacity/hover/popover-open visibility rules; ScheduledActions
            renders only the icon buttons. */}
        {!isMobile && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 opacity-0 transition-opacity",
              "group-hover:opacity-100 focus-within:opacity-100",
              // Keep the cluster visible while any popover hosted by an action
              // is open (matches SavedItem); without this, the trigger would
              // disappear under the user's pointer the moment the popover mounts.
              "has-[[data-state=open]]:opacity-100"
            )}
          >
            <ScheduledActions
              scheduled={scheduled}
              variant="hover-cluster"
              onEdit={onEdit}
              onCancel={onCancel}
              onSendNow={onSendNow}
            />
          </div>
        )}
      </div>

      {isMobile && (
        <ScheduledActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          scheduled={scheduled}
          onEdit={onEdit}
          onSendNow={onSendNow}
          onCancel={onCancel}
        />
      )}
    </>
  )
}
