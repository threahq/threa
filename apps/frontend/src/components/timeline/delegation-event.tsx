import { useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Check, ChevronDown, ChevronRight, Copy, Loader2, TerminalSquare } from "lucide-react"
import {
  DelegationStatuses,
  type DelegationCreatedEventPayload,
  type DelegationStatus,
  type DelegationStatusChangedEventPayload,
  type StreamEvent,
} from "@threa/types"
import { delegationsApi } from "@/api"
import { useActors } from "@/hooks"
import { DELEGATION_STATUS_LABEL, DELEGATION_TERMINAL } from "@/lib/delegation-display"
import { cn } from "@/lib/utils"

interface DelegationEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  /**
   * The latest `delegation:status_changed` patch for this delegation within
   * the loaded window — the authoritative live status, so every viewer (not
   * just the one who clicked Cancel) sees the same state, and it survives a
   * reload. Absent means the delegation is still open.
   */
  statusPatch?: DelegationStatusChangedEventPayload
}

/**
 * Compile the card's payload into one paste-ready prompt for a local agent —
 * the zero-tooling hand-off path (roadmap 5.2). Everything comes from the
 * `delegation:created` payload, so no fetch is needed.
 */
export function buildDelegationPrompt(payload: DelegationCreatedEventPayload): string {
  const parts = [`# ${payload.title}`, "", payload.brief]
  if (payload.contextRefs.length > 0) {
    parts.push("", "## Threa context refs", ...payload.contextRefs.map((ref) => `- ${ref}`))
  }
  return parts.join("\n")
}

/**
 * Timeline card for `delegation:created` (roadmap 5.1/5.2), in the follow-up
 * card's vocabulary (icon tile · content · right-slot actions). One component
 * renders every status (INV-29/43): the created row is the card; each
 * `delegation:status_changed` patch advances it via `statusPatch`.
 *
 * Copy prompt confirms in place by swapping the icon to a checkmark — same
 * footprint, no toast, no layout shift (INV-63/21). Cancel is a button (it
 * mutates — INV-40) shown only while non-terminal; "View result" is a link
 * (navigation — INV-40) shown when completed with a linked result message.
 * The status from `statusPatch` is authoritative; the local optimistic flip
 * only fast-paths the clicking member's own cancel.
 */
export function DelegationEvent({ event, workspaceId, streamId, statusPatch }: DelegationEventProps) {
  const { getActorName } = useActors(workspaceId)
  const payload = event.payload as DelegationCreatedEventPayload | undefined
  const [optimisticallyCancelled, setOptimisticallyCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!payload) return null

  const status: DelegationStatus = optimisticallyCancelled
    ? DelegationStatuses.CANCELLED
    : (statusPatch?.status ?? DelegationStatuses.OPEN)
  const terminal = DELEGATION_TERMINAL.has(status)
  const actorName = getActorName(event.actorId, event.actorType)

  const metaParts = [`${actorName} · ${DELEGATION_STATUS_LABEL[status]}`]
  if (statusPatch?.claimedByLabel && !optimisticallyCancelled) metaParts.push(statusPatch.claimedByLabel)
  const statusNote = !optimisticallyCancelled ? statusPatch?.statusNote : null
  const resultMessageId =
    status === DelegationStatuses.COMPLETED ? (statusPatch?.resultMessageId ?? undefined) : undefined

  async function handleCopy() {
    if (!payload) return
    try {
      await navigator.clipboard.writeText(buildDelegationPrompt(payload))
    } catch {
      toast.error("Couldn't copy the prompt")
      return
    }
    setCopyDone(true)
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyDone(false), 1200)
  }

  async function handleCancel() {
    // Re-entrancy guard instead of `disabled` (disable would blur the focused
    // button); `aria-disabled` keeps it in the focus tree.
    if (!payload || cancelling || terminal) return
    setCancelling(true)
    try {
      const { cancelled: didCancel } = await delegationsApi.cancel(workspaceId, payload.delegationId)
      if (didCancel) {
        setOptimisticallyCancelled(true)
      } else {
        // Lost the race (completed/failed/expired/cancelled elsewhere). Don't
        // flip — the authoritative patch will land with what actually happened.
        toast.info("This delegation already finished or was cancelled")
      }
    } catch {
      toast.error("Couldn't cancel the delegation")
    } finally {
      setCancelling(false)
    }
  }

  // Cancelled keeps the SAME button element relabeled (the follow-up card's
  // pattern): the clicker's focus stays on it instead of dropping to <body>,
  // and aria-live announces the flip. Other terminal statuses hide Cancel —
  // a "Cancelled" label under a Completed/Failed/Expired card would lie.
  const cancelled = status === DelegationStatuses.CANCELLED
  const showCancelSlot = !terminal || cancelled
  let cancelIcon: ReactNode = null
  if (cancelling) cancelIcon = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
  else if (cancelled) cancelIcon = <Check className="h-3 w-3" aria-hidden="true" />

  return (
    <div className="px-3 sm:px-6 py-1.5">
      <div
        className={cn(
          "rounded-[10px] border px-3 py-2 transition-colors",
          terminal ? "border-border/60 bg-muted/20" : "border-border bg-muted/40"
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              terminal ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
            )}
          >
            <TerminalSquare className="h-4 w-4" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-[13px] font-medium",
                status === DelegationStatuses.CANCELLED || status === DelegationStatuses.EXPIRED
                  ? "text-muted-foreground line-through"
                  : "text-foreground/90"
              )}
            >
              {payload.title}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{metaParts.join(" · ")}</p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {resultMessageId && (
              <Link
                to={`/w/${workspaceId}/s/${streamId}?m=${resultMessageId}`}
                className="inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                View result
              </Link>
            )}
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copyDone ? "Prompt copied" : "Copy prompt"}
              aria-live="polite"
              title="Copy the hand-off prompt for a local agent"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copyDone ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" />
              )}
              Copy prompt
            </button>
            {showCancelSlot && (
              <button
                type="button"
                onClick={handleCancel}
                aria-disabled={cancelled || cancelling}
                aria-busy={cancelling}
                aria-live="polite"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors",
                  cancelled || cancelling ? "cursor-default" : "hover:bg-muted hover:text-foreground"
                )}
              >
                {cancelIcon}
                {cancelled ? "Cancelled" : "Cancel"}
              </button>
            )}
          </div>
        </div>

        {statusNote && <p className="mt-1.5 pl-10 text-[11px] text-muted-foreground">{statusNote}</p>}

        <button
          type="button"
          onClick={() => setBriefOpen((open) => !open)}
          aria-expanded={briefOpen}
          className="mt-1.5 inline-flex items-center gap-1 pl-10 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {briefOpen ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )}
          {briefOpen ? "Hide hand-off prompt" : "Show hand-off prompt"}
        </button>
        {briefOpen && (
          <div className="mt-1.5 ml-10 rounded-md border border-border/60 bg-background/60 p-2">
            {/* The brief IS a prompt — show it as source text (mono, pre-wrap),
                not rendered prose, so what you read is exactly what Copy ships. */}
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
              {buildDelegationPrompt(payload)}
            </pre>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Paste this into your local agent (Claude Code, etc.) to run the task on your machine.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
