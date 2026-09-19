import { useRef, useState } from "react"
import { toast } from "sonner"
import { Check, CircleHelp, Loader2, X } from "lucide-react"
import {
  DECISION_NOTE_MAX_CHARS,
  type DecisionOption,
  type DecisionRequest,
  type DecisionRequestedEventPayload,
  type DecisionResolution,
  type DecisionResolvedEventPayload,
  type EnclaveStreamEnvelope,
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
import { useDecryptedDecision } from "@/hooks/use-decrypted-decision"
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

function buttonVariantFor(tone: DecisionOption["tone"]): "default" | "outline" {
  return tone === "primary" ? "default" : "outline"
}

const OPEN_BUTTON_CLASS: Record<DecisionOption["tone"], string> = {
  primary: "",
  neutral: "",
  destructive: "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
}

const CHOSEN_PILL_CLASS: Record<DecisionOption["tone"], string> = {
  primary:
    "bg-[hsl(142_76%_36%/0.14)] text-[hsl(142,76%,30%)] hover:bg-[hsl(142_76%_36%/0.14)] hover:text-[hsl(142,76%,30%)]",
  neutral: "bg-muted text-foreground/80 hover:bg-muted hover:text-foreground/80",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive",
}

/** Stand-in for a sealed card's question when it can't be read (locked / decrypting / failed). */
const DECISION_DECRYPT_NOTICE_TEXT: Record<"locked" | "pending" | "failed", string> = {
  locked: "Unlock this scratchpad to read this decision",
  pending: "Decrypting…",
  failed: "Couldn't decrypt this decision",
}

const RAIL_CLASS: Record<DecisionOption["tone"] | "open" | "closed", string> = {
  open: "border-l-primary bg-primary/[0.06]",
  primary: "border-l-[hsl(142,76%,36%)]",
  neutral: "border-l-muted-foreground/30",
  destructive: "border-l-destructive",
  closed: "border-l-muted-foreground/30",
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

  // Resolved before the early return so the sealed-card hook can be given the
  // winning resolution (its note is sealed under the same key as the card).
  const patch = highestPatch.current
  let snapshot: DecisionSnapshot | null = decision
    ? { status: decision.status, resolution: decision.resolution, version: decision.version }
    : null
  if (snapshot && patch && patch.version >= snapshot.version) {
    snapshot = { status: patch.status, resolution: patch.resolution, version: patch.version }
  }
  if (snapshot && local && local.version >= snapshot.version) snapshot = local

  const sealed = useDecryptedDecision(workspaceId, decision, snapshot?.resolution)

  if (!payload || !decision || !snapshot) return null

  const { status, resolution, version } = snapshot
  const open = status === "open"

  const requesterLabel = (decision.requesterBotId ? getBot(decision.requesterBotId)?.name : null) ?? "A bot"

  const cardIsSealed = sealed.status !== "plaintext"
  // A sealed card that can't be opened has zero-width placeholders where its
  // question and its option labels should be, so it shows a notice and no
  // buttons: nobody answers a question they can't read, and a locked viewer
  // couldn't seal the note anyway.
  const unreadable = cardIsSealed && sealed.status !== "decrypted" ? sealed.status : null
  const title = sealed.content?.title ?? decision.title
  const bodyMarkdown = cardIsSealed ? sealed.content?.bodyMarkdown : decision.bodyMarkdown
  const labelFor = (option: DecisionOption) => sealed.content?.optionLabels[option.id] ?? option.label
  const shownNote = cardIsSealed ? sealed.note : resolution?.note

  const handleResolve = async (optionId: string) => {
    // Re-entrancy guard instead of `disabled`: disabling would blur the button
    // the viewer just pressed.
    if (!open || pendingOptionId) return
    setPendingOptionId(optionId)
    const trimmed = note.trim()
    try {
      // A sealed card takes only a sealed note and a plaintext one only plaintext
      // (INV-E1) — the seal happens here, client-side, or the answer goes without
      // a note rather than sending one the server could read.
      let sealedNote: { ciphertext: string; envelope: EnclaveStreamEnvelope } | undefined
      if (cardIsSealed && trimmed.length > 0) {
        if (!sealed.sealNote) {
          toast.error("Unlock this scratchpad before answering")
          return
        }
        try {
          sealedNote = await sealed.sealNote(trimmed)
        } catch {
          toast.error("Couldn't seal your note")
          return
        }
      }
      const { decision: resolved } = await decisionsApi.resolve(workspaceId, decision.id, {
        optionId,
        note: !cardIsSealed && trimmed.length > 0 ? trimmed : undefined,
        sealedNote,
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

  const chosenOption = resolution ? decision.options.find((option) => option.id === resolution.optionId) : undefined
  const chosenLabel = chosenOption ? labelFor(chosenOption) : (resolution?.optionId ?? null)
  const chosenTone: DecisionOption["tone"] = chosenOption?.tone ?? "neutral"
  let terminalLine: string | null = unreadable ? null : chosenLabel
  if (!terminalLine && status === "cancelled") terminalLine = "Cancelled"
  if (!terminalLine && status === "expired") terminalLine = "Expired"
  const deciderName = resolution?.decidedBy ? getActorName(resolution.decidedBy, "user") : null
  const decidedAgo = resolution?.decidedAt ? formatRelativeTime(new Date(resolution.decidedAt)) : null

  let rail: keyof typeof RAIL_CLASS = "closed"
  if (open) rail = "open"
  else if (resolution) rail = chosenTone

  // Terminal with a resolution keeps ONLY the chosen option's Button mounted, in
  // the same slot with the same key, so the button the viewer just pressed keeps
  // focus and its relabeling is announced (the bot-access pattern).
  let shownOptions = open ? decision.options : decision.options.filter((option) => option.id === resolution?.optionId)
  if (unreadable) shownOptions = []

  return (
    <div className="px-3 sm:px-6 py-1.5">
      <div
        className={cn("rounded-r-[10px] border-l-[3px] py-2.5 pl-4 pr-3 transition-colors sm:pr-4", RAIL_CLASS[rail])}
      >
        <div className="flex items-start gap-2">
          <CircleHelp
            className={cn("mt-[3px] h-4 w-4 shrink-0", open ? "text-primary" : "text-muted-foreground/70")}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {unreadable ? (
              <p className="text-[14px] italic leading-snug text-muted-foreground">
                {DECISION_DECRYPT_NOTICE_TEXT[unreadable]}
              </p>
            ) : (
              <p className="text-[14px] font-semibold leading-snug text-foreground">{title}</p>
            )}
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground/70">{requesterLabel}</span>{" "}
              {open ? "needs a decision" : "asked for a decision"}
            </p>
          </div>
        </div>

        {bodyMarkdown && (
          <div className="mt-2 pl-6">
            <MarkdownContent
              content={bodyMarkdown}
              messageId={event.id}
              className="text-[13px] leading-relaxed text-foreground/90"
            />
          </div>
        )}

        <div className="mt-3 pl-6">
          <div
            className={cn(
              "flex",
              open ? "flex-col gap-2 sm:flex-row sm:items-center" : "flex-wrap items-center gap-x-2 gap-y-1"
            )}
          >
            {open && decision.allowNote && !unreadable && (
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={DECISION_NOTE_MAX_CHARS}
                rows={1}
                aria-label="Note (optional)"
                placeholder="Add a note for the bot"
                className="h-9 min-h-9 w-full resize-none py-2 text-[13px] sm:order-last sm:min-w-[12rem] sm:flex-1"
              />
            )}
            {/* One slot for the option buttons in both states, so the button the
                viewer pressed is the element that relabels (focus retained). */}
            <div className="flex flex-wrap items-center gap-2">
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
                    className={cn(
                      chosen
                        ? cn(
                            "h-7 cursor-default rounded-full border-transparent px-2.5 text-[12px]",
                            CHOSEN_PILL_CLASS[chosenTone]
                          )
                        : OPEN_BUTTON_CLASS[option.tone]
                    )}
                  >
                    {pendingOptionId === option.id && (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />
                    )}
                    {chosen && !pendingOptionId && chosenTone === "destructive" && (
                      <X className="mr-1 h-3 w-3" aria-hidden="true" />
                    )}
                    {chosen && !pendingOptionId && chosenTone !== "destructive" && (
                      <Check className="mr-1 h-3 w-3" aria-hidden="true" />
                    )}
                    {labelFor(option)}
                  </Button>
                )
              })}
            </div>
            {!open && shownOptions.length === 0 && terminalLine && (
              <span
                aria-live="polite"
                className="inline-flex h-7 items-center rounded-full bg-muted px-2.5 text-[12px] text-muted-foreground"
              >
                {terminalLine}
              </span>
            )}
            {!open && (deciderName || decidedAgo) && (
              <span className="text-[12px] text-muted-foreground">
                {deciderName}
                {deciderName && decidedAgo ? ", " : ""}
                {decidedAgo}
              </span>
            )}
          </div>

          {!open && shownNote && (
            <p className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-2.5 text-[13px] leading-relaxed text-foreground/80">
              {shownNote}
            </p>
          )}
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
