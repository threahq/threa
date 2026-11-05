import { useEffect, useRef } from "react"
import { useMutationState } from "@tanstack/react-query"
import { X } from "lucide-react"
import type { InboxClearMode } from "@threahq/types"
import { SettingsGearLink } from "@/components/in-context-settings/settings-gear-link"
import { SETTING_CHOICE_LABELS } from "@/components/settings/settings-registry"
import { clearInboxMutationKey } from "@/hooks/use-unread-counts"

/**
 * Something the sidebar did on its own, by one of the viewer's rules: a label
 * stripped on move, or a stream settled out of the Inbox.
 */
export type SidebarReceipt =
  | { kind: "label-removed"; streamId: string; labelId: string }
  | { kind: "settled"; streamId: string; mode: Exclude<InboxClearMode, "manual"> }

/**
 * The stream that just left the Inbox by the viewer's settling rule, or null.
 * Only the open stream counts: it is the one the viewer acted on, and a stream
 * that left for any other reason (muted, archived, gone) or by their own Settle
 * is no surprise.
 */
export function settledByRule({
  before,
  after,
  activeStreamId,
  settledByHand,
  stillListed,
}: {
  before: ReadonlySet<string>
  after: ReadonlySet<string>
  activeStreamId: string | undefined
  settledByHand: ReadonlySet<string>
  /** Still in the sidebar, unmuted and unarchived. */
  stillListed: (streamId: string) => boolean
}): string | null {
  if (!activeStreamId || !before.has(activeStreamId) || after.has(activeStreamId)) return null
  if (settledByHand.has(activeStreamId) || !stillListed(activeStreamId)) return null
  return activeStreamId
}

/**
 * Calls `onSettled` when the open stream leaves the Inbox by the settling rule
 * rather than by hand. Hand-settles are the clear-inbox mutations submitted
 * since the stream last entered the Inbox.
 */
export function useSettledByRule({
  workspaceId,
  inboxStreamIds,
  activeStreamId,
  mode,
  stillListed,
  onSettled,
}: {
  workspaceId: string
  inboxStreamIds: ReadonlySet<string>
  activeStreamId: string | undefined
  mode: InboxClearMode
  stillListed: (streamId: string) => boolean
  onSettled: (receipt: Extract<SidebarReceipt, { kind: "settled" }>) => void
}) {
  const handSettles = useMutationState({
    filters: { mutationKey: clearInboxMutationKey(workspaceId) },
    select: (mutation) => ({
      streamIds: (mutation.state.variables as { streamIds: string[] } | undefined)?.streamIds ?? [],
      at: mutation.state.submittedAt,
    }),
  })
  const latest = useRef({ handSettles, stillListed, onSettled })
  latest.current = { handSettles, stillListed, onSettled }
  const previous = useRef(inboxStreamIds)
  const enteredAt = useRef(new Map<string, number>())

  useEffect(() => {
    const before = previous.current
    previous.current = inboxStreamIds
    const now = Date.now()
    for (const streamId of inboxStreamIds) if (!before.has(streamId)) enteredAt.current.set(streamId, now)
    if (mode === "manual" || !activeStreamId) return
    const since = enteredAt.current.get(activeStreamId) ?? 0
    const settledByHand = new Set(
      latest.current.handSettles.filter((settle) => settle.at >= since).flatMap((settle) => settle.streamIds)
    )
    const streamId = settledByRule({
      before,
      after: inboxStreamIds,
      activeStreamId,
      settledByHand,
      stillListed: latest.current.stillListed,
    })
    if (streamId) latest.current.onSettled({ kind: "settled", streamId, mode })
  }, [inboxStreamIds, activeStreamId, mode])
}

/**
 * A quiet row under the section the stream moved through, saying what happened
 * and which rule did it, with Undo where it can be undone and a gear to the rule.
 * It takes about a row's height, standing in for the row that left.
 */
export function SidebarReceiptRow({
  receipt,
  streamName,
  labelName,
  onUndo,
  onDismiss,
}: {
  receipt: SidebarReceipt
  streamName: string
  labelName?: string
  onUndo?: () => void
  onDismiss: () => void
}) {
  const labelRemoved = receipt.kind === "label-removed"
  const title = labelRemoved ? `Removed “${labelName ?? "label"}” from ${streamName}` : `Settled ${streamName}`
  const rule = labelRemoved ? SETTING_CHOICE_LABELS["label-move"].always : SETTING_CHOICE_LABELS.settling[receipt.mode]

  return (
    <div
      data-testid="sidebar-receipt"
      className="mx-2 my-1 flex items-center gap-1 rounded-md bg-muted/70 py-1 pl-2.5 pr-1 text-xs"
    >
      <span role="status" className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground" title={title}>
          {title}
        </span>
        <span className="block truncate text-muted-foreground">{rule}</span>
      </span>
      {onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="h-11 shrink-0 rounded-md px-2 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 [@media(pointer:coarse)]:h-11"
        >
          Undo
        </button>
      )}
      <SettingsGearLink
        setting={labelRemoved ? "label-move" : "settling"}
        label={labelRemoved ? "Label settings" : "Inbox settings"}
      />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-6 [@media(pointer:coarse)]:size-11"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
