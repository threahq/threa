import { useRef, useState } from "react"
import { toast } from "sonner"
import { Check, CircleHelp, Loader2 } from "lucide-react"
import {
  DECISION_NOTE_MAX_CHARS,
  type DecisionOption,
  type DecisionRequest,
  type DecisionRequestedEventPayload,
  type DecisionResolution,
  type DecisionResolvedEventPayload,
  type DecisionRequestStatus,
  type StreamEvent,
  type ThreadSummary,
} from "@threahq/types"
import { decisionsApi } from "@/api"
import { ApiError } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { useActors, useThreadDraft } from "@/hooks"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { ThreadSlot } from "./thread-slot"
import { useHostArchived } from "./host-archived-context"
import { useThreadAnchor } from "./use-thread-anchor"

interface DecisionEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  /**
   * The `decision:resolved` patch for this request within the loaded window — the
   * authoritative outcome, so every viewer sees the same terminal state and it
   * survives a reload. Absent means the request is still open in this window.
   */
  statusPatch?: DecisionResolvedEventPayload
  /**
   * True when this card is pinned atop its OWN thread panel as the thread parent.
   * Its footer chip would loop back to the panel already open, so it's suppressed.
   */
  isThreadParent?: boolean
}

interface DecisionSnapshot {
  status: DecisionRequestStatus
  resolution?: DecisionResolution
  version: number
}

function buttonVariantFor(tone: DecisionOption["tone"]): "default" | "outline" | "destructive" {
  if (tone === "destructive") return "destructive"
  if (tone === "neutral") return "outline"
  return "default"
}

/**
 * Timeline card for `decision:requested` (Hermes): a call a bot runtime cannot
 * make for itself, put to its human. One component renders every status
 * (INV-29/43) — the requested row is the card, the `decision:resolved` patch
 * resolves it via `statusPatch`.
 *
 * The card renders entirely from the event payload; no fetch on the happy path.
 * Anyone who can see the stream may answer — the backend gates on
 * `checkStreamAccess` (INV-62), so there is no membership gate here. Every click
 * sends the version the card is showing, so a second answer loses the CAS race
 * (409 `DECISION_NOT_OPEN`) whose body carries the winning row, which the card
 * shows instead. INV-63: no success toast — the card flips.
 */
export function DecisionEvent({ event, workspaceId, streamId, statusPatch, isThreadParent }: DecisionEventProps) {
  const payload = event.payload as
    | (DecisionRequestedEventPayload & { threadId?: string; replyCount?: number; threadSummary?: ThreadSummary })
    | undefined
  const { getActorName, getBot } = useActors(workspaceId)
  const [note, setNote] = useState("")
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null)
  // What this client learned first-hand: the row the resolve call returned, or
  // the winning row the 409 handed back after losing the CAS race. Carries its
  // own version, so it never walks a newer patch back.
  const [local, setLocal] = useState<DecisionSnapshot | null>(null)
  // The highest-version patch this card has seen. Patch delivery is not ordered
  // across a socket append and a window re-read, so a lower version is stale and
  // must never walk the card back to an earlier state.
  const highestPatch = useRef<DecisionResolvedEventPayload | null>(null)

  const { threadHref, replyUrl, effectiveThreadId } = useThreadAnchor(workspaceId, streamId, event.id, {
    threadId: payload?.threadId,
  })
  const threadDraft = useThreadDraft(workspaceId, event.id, effectiveThreadId)
  const hostArchived = useHostArchived()

  const decision = payload?.decision
  if (decision && statusPatch && statusPatch.version >= decision.version) {
    const seen = highestPatch.current
    if (!seen || statusPatch.version > seen.version) highestPatch.current = statusPatch
  }

  if (!payload || !decision) return null

  const patch = highestPatch.current
  let snapshot: DecisionSnapshot = {
    status: decision.status,
    resolution: decision.resolution,
    version: decision.version,
  }
  if (patch && patch.version >= snapshot.version) {
    snapshot = { status: patch.status, resolution: patch.resolution, version: patch.version }
  }
  if (local && local.version >= snapshot.version) snapshot = local

  const { status, resolution, version } = snapshot
  const open = status === "open"

  const requesterLabel = (decision.requesterBotId ? getBot(decision.requesterBotId)?.name : null) ?? "A bot"

  const handleResolve = async (optionId: string) => {
    // Re-entrancy guard instead of `disabled`: disabling would blur the button
    // the viewer just pressed.
    if (!open || pendingOptionId) return
    setPendingOptionId(optionId)
    const trimmed = note.trim()
    try {
      const { decision: resolved } = await decisionsApi.resolve(workspaceId, decision.id, {
        optionId,
        note: trimmed.length > 0 ? trimmed : undefined,
        version,
      })
      setLocal({ status: resolved.status, resolution: resolved.resolution, version: resolved.version })
    } catch (error) {
      if (ApiError.isApiError(error) && error.code === "DECISION_NOT_OPEN") {
        toast.info("This decision was already answered")
        const winner = error.details as Partial<DecisionRequest> | undefined
        if (winner && typeof winner.version === "number" && typeof winner.status === "string") {
          setLocal({ status: winner.status, resolution: winner.resolution, version: winner.version })
        }
      } else {
        toast.error("Couldn't record your answer")
      }
    } finally {
      setPendingOptionId(null)
    }
  }

  const chosenLabel = resolution
    ? (decision.options.find((option) => option.id === resolution.optionId)?.label ?? resolution.optionId)
    : null
  let terminalLine: string | null = chosenLabel
  if (!terminalLine && status === "cancelled") terminalLine = "Cancelled"
  if (!terminalLine && status === "expired") terminalLine = "Expired"
  const deciderName = resolution?.decidedBy ? getActorName(resolution.decidedBy, "user") : null

  const metaParts: string[] = []
  if (deciderName) metaParts.push(deciderName)
  if (resolution?.decidedAt) metaParts.push(formatRelativeTime(new Date(resolution.decidedAt)))

  // Terminal with a resolution keeps ONLY the chosen option's Button mounted, in
  // the same slot with the same key, so the button the viewer just pressed keeps
  // focus and its relabeling is announced (the bot-access pattern).
  const shownOptions = open ? decision.options : decision.options.filter((option) => option.id === resolution?.optionId)

  return (
    <div className="px-3 sm:px-6 py-1.5">
      <div
        className={cn(
          "rounded-[10px] border px-3 py-2.5 transition-colors",
          open ? "border-border bg-muted/40" : "border-border/60 bg-muted/20"
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              open ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
            )}
          >
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">{requesterLabel}</span>{" "}
              {open ? "needs a decision" : "asked for a decision"}
            </p>
            <p className="mt-0.5 text-[13px] font-medium text-foreground">{decision.title}</p>

            {decision.bodyMarkdown && (
              <div className="mt-1.5">
                <MarkdownContent
                  content={decision.bodyMarkdown}
                  messageId={event.id}
                  className="text-[13px] leading-relaxed"
                />
              </div>
            )}

            <div className="mt-2.5">
              {open && decision.allowNote && (
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={DECISION_NOTE_MAX_CHARS}
                  rows={2}
                  aria-label="Note (optional)"
                  placeholder="Add a note (optional)"
                  className="mb-2 w-full text-[13px]"
                />
              )}
              {shownOptions.length > 0 && (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  {shownOptions.map((option) => {
                    const chosen = !open
                    return (
                      <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        variant={chosen ? "outline" : buttonVariantFor(option.tone)}
                        aria-busy={pendingOptionId === option.id}
                        aria-disabled={chosen}
                        aria-live="polite"
                        onClick={() => handleResolve(option.id)}
                        className={cn("w-full sm:w-auto", chosen && "cursor-default hover:bg-transparent")}
                      >
                        {pendingOptionId === option.id && (
                          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />
                        )}
                        {chosen && !pendingOptionId && <Check className="mr-1.5 h-3 w-3" aria-hidden="true" />}
                        {option.label}
                      </Button>
                    )
                  })}
                </div>
              )}
              {!open && shownOptions.length === 0 && terminalLine && (
                <span aria-live="polite" className="text-[13px] font-medium text-foreground/90">
                  {terminalLine}
                </span>
              )}
              {!open && (metaParts.length > 0 || resolution?.note) && (
                <div className="mt-1">
                  {metaParts.length > 0 && <p className="text-[12px] text-muted-foreground">{metaParts.join(" · ")}</p>}
                  {resolution?.note && (
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted-foreground">{resolution.note}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isThreadParent && (
        <ThreadSlot
          anchorId={event.id}
          streamId={streamId}
          replyCount={payload.replyCount ?? 0}
          threadHref={threadHref}
          summary={payload.threadSummary}
          workspaceId={workspaceId}
          draft={threadDraft}
          draftHref={replyUrl}
          hostArchived={hostArchived}
        />
      )}
    </div>
  )
}
