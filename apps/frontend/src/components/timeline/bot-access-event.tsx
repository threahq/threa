import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Bot, Check, Loader2, X } from "lucide-react"
import type { BotAccessRequestedEventPayload, BotAccessStatusChangedEventPayload, StreamEvent } from "@threahq/types"
import { botAccessApi } from "@/api"
import { cn } from "@/lib/utils"

interface BotAccessEventProps {
  event: StreamEvent
  workspaceId: string
  /**
   * The `bot_access:status_changed` patch for this request within the loaded
   * window — the authoritative resolution, so every viewer (not just the member
   * who clicked) sees the same terminal state, and it survives a reload. Absent
   * means the request is still open.
   */
  statusPatch?: BotAccessStatusChangedEventPayload
  /**
   * Approve / Deny render only for a stream MEMBER (brief decision 4): granting a
   * bot standing machine-access is more consequential than flipping a card, so a
   * mere viewer sees the card and its status but no action buttons.
   */
  viewerIsMember?: boolean
}

/**
 * Timeline card for `bot_access:requested` (F3): a bot runtime that received the
 * workspace-wide delegation nudge but lacks stream access filed a request. One
 * component renders every status (INV-29/43): the requested row is the card;
 * the `bot_access:status_changed` patch resolves it via `statusPatch`.
 *
 * The card renders entirely from the event payload SNAPSHOT (`botName`,
 * `delegationTitle`) — a non-member approver cannot resolve an ungranted personal
 * bot from their roster (bot visibility is grant-based), so the card must not
 * depend on the roster. Approve / Deny are buttons (they mutate — INV-40), shown
 * only to members while the request is open; each relabels in place to its
 * terminal state so the clicking member's focus is retained (aria-disabled keeps
 * it in the focus tree; aria-live announces the flip). The `statusPatch` status
 * is authoritative; the local optimistic flips only fast-path the clicker.
 * INV-63: no success toast (the card flips), `toast.info` on a lost race,
 * `toast.error` on failure.
 */
export function BotAccessEvent({ event, workspaceId, statusPatch, viewerIsMember }: BotAccessEventProps) {
  const payload = event.payload as BotAccessRequestedEventPayload | undefined
  const [optimisticApproved, setOptimisticApproved] = useState(false)
  const [optimisticDenied, setOptimisticDenied] = useState(false)
  const [approving, setApproving] = useState(false)
  const [denying, setDenying] = useState(false)

  if (!payload) return null

  let status = statusPatch?.status
  if (optimisticApproved) status = "approved"
  else if (optimisticDenied) status = "denied"
  const approved = status === "approved"
  const denied = status === "denied"
  const terminal = approved || denied

  const metaParts: string[] = []
  if (payload.delegationTitle) metaParts.push(`To claim: ${payload.delegationTitle}`)
  if (payload.requestedByLabel) metaParts.push(payload.requestedByLabel)

  async function handleApprove() {
    // Re-entrancy guard instead of `disabled` (disable would blur the focused
    // button); `aria-disabled` keeps it in the focus tree.
    if (!payload || approving || terminal) return
    setApproving(true)
    try {
      const { approved: didApprove } = await botAccessApi.approve(workspaceId, payload.requestId)
      if (didApprove) {
        setOptimisticApproved(true)
      } else {
        // Lost the race (resolved elsewhere). Don't flip — the authoritative
        // patch will land with what actually happened.
        toast.info("This request was already resolved")
      }
    } catch {
      toast.error("Couldn't approve the access request")
    } finally {
      setApproving(false)
    }
  }

  async function handleDeny() {
    if (!payload || denying || terminal) return
    setDenying(true)
    try {
      const { denied: didDeny } = await botAccessApi.deny(workspaceId, payload.requestId)
      if (didDeny) {
        setOptimisticDenied(true)
      } else {
        toast.info("This request was already resolved")
      }
    } catch {
      toast.error("Couldn't deny the access request")
    } finally {
      setDenying(false)
    }
  }

  // Members get the relabeling-button pattern: the clicked button stays mounted
  // and relabels to its terminal state (focus retained, announced), the other
  // slot drops. A terminal state reached via the authoritative patch (a member
  // who didn't click) shows the same relabeled, aria-disabled button.
  const showApproveSlot = !terminal || approved
  const showDenySlot = !terminal || denied
  let approveIcon: ReactNode = null
  if (approving) approveIcon = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
  else if (approved) approveIcon = <Check className="h-3 w-3" aria-hidden="true" />
  let denyIcon: ReactNode = null
  if (denying) denyIcon = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
  else if (denied) denyIcon = <X className="h-3 w-3" aria-hidden="true" />

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
            <Bot className="h-4 w-4" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-foreground/90">
              <span className="font-medium">{payload.botName}</span> requests access to this stream
            </p>
            {metaParts.length > 0 && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{metaParts.join(" · ")}</p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {viewerIsMember ? (
              <>
                {showApproveSlot && (
                  <button
                    type="button"
                    onClick={handleApprove}
                    aria-disabled={approved || approving}
                    aria-busy={approving}
                    aria-live="polite"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                      approved || approving
                        ? "cursor-default text-muted-foreground"
                        : "text-primary hover:bg-primary/10"
                    )}
                  >
                    {approveIcon}
                    {approved ? "Access granted" : "Approve"}
                  </button>
                )}
                {showDenySlot && (
                  <button
                    type="button"
                    onClick={handleDeny}
                    aria-disabled={denied || denying}
                    aria-busy={denying}
                    aria-live="polite"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors",
                      denied || denying ? "cursor-default" : "hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {denyIcon}
                    {denied ? "Denied" : "Deny"}
                  </button>
                )}
              </>
            ) : (
              terminal && (
                <span
                  aria-live="polite"
                  className="inline-flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium text-muted-foreground"
                >
                  {approved ? (
                    <Check className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <X className="h-3 w-3" aria-hidden="true" />
                  )}
                  {approved ? "Access granted" : "Denied"}
                </span>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
