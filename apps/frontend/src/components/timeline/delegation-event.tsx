import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Link2,
  Loader2,
  MessageSquareReply,
  RotateCcw,
  TerminalSquare,
  X,
} from "lucide-react"
import {
  DelegationStatuses,
  type DelegationCreatedEventPayload,
  type DelegationStatus,
  type DelegationStatusChangedEventPayload,
  type StreamEvent,
  type ThreadSummary,
} from "@threa/types"
import { delegationsApi } from "@/api"
import { usePanel } from "@/contexts"
import { useActors } from "@/hooks"
import { agentOutcomeKeys } from "@/hooks/use-agent-outcomes"
import { delegationKeys } from "@/hooks/use-stream-delegations"
import {
  delegationAvailabilityLabel,
  DELEGATION_REOPEN_REASON_LABEL,
  DELEGATION_TERMINAL,
} from "@/lib/delegation-display"
import { buildDelegationLink } from "@/lib/stream-links"
import { cn } from "@/lib/utils"
import { ThreadSlot } from "./thread-slot"
import {
  TimelineCardActionDrawer,
  TimelineCardContextMenu,
  TimelineCardQuickActions,
  type TimelineCardAction,
  useTimelineCardActionSurface,
} from "./timeline-card-actions"
import { useThreadAnchor } from "./use-thread-anchor"

function delegationPatchSignature(patch: DelegationStatusChangedEventPayload | undefined): string | undefined {
  if (!patch) return undefined
  return JSON.stringify([
    patch.delegationId,
    patch.status,
    patch.claimedByLabel ?? null,
    patch.resultMessageId ?? null,
    patch.threadStreamId ?? null,
    patch.statusNote ?? null,
    patch.reason ?? null,
  ])
}

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
  /**
   * True when this card is pinned atop its OWN thread panel as the thread parent.
   * Its thread affordance (footer chip + Discuss) would loop back to the panel
   * already open, so it's suppressed here.
   */
  isThreadParent?: boolean
}

/**
 * Compile the card's payload into one paste-ready prompt for a local agent —
 * the zero-tooling hand-off path (roadmap 5.2). Everything comes from the
 * `delegation:created` payload, so no fetch is needed.
 *
 * With `opts`, the prompt is self-contained for the lifecycle too: it carries
 * the delegation id, the API breadcrumb (claim → token header → status →
 * complete), and an honest note that context refs resolve only through Threa —
 * so an agent WITH an API key knows exactly how to claim and report, and one
 * without knows to ask instead of hallucinating (adversarial-review finding).
 */
export function buildDelegationPrompt(
  payload: DelegationCreatedEventPayload,
  opts?: { workspaceId: string; origin: string }
): string {
  const parts = [`# ${payload.title}`, "", payload.brief]
  if (payload.contextRefs.length > 0) {
    parts.push("", "## Threa context refs", ...payload.contextRefs.map((ref) => `- ${ref}`))
  }
  if (opts) {
    const base = `${opts.origin}/api/v1/workspaces/${opts.workspaceId}/delegations/${payload.delegationId}`
    parts.push(
      "",
      "## Threa delegation lifecycle",
      `This task is tracked as delegation ${payload.delegationId}. If you have a Threa API key`,
      `(created in Threa under Settings > API keys, scopes delegations:read + delegations:write),`,
      `work it through the API so the card tracks your progress:`,
      "",
      `1. Inspect: \`GET ${base}\`. Review the brief and context refs, which are pointers into Threa.`,
      `2. If you accept the work, claim it: \`POST ${base}/claim\` with body {"claimedByLabel":"<executor label>"}.`,
      `   The response includes a claimToken shown once and a 15-minute lease.`,
      `3. Send the token as an \`X-Threa-Callback-Token\` header on later calls.`,
      `   \`POST ${base}/heartbeat\` optionally renews the lease; \`POST ${base}/status\` {"statusNote":"..."} reports progress.`,
      `   \`POST ${base}/complete\` {"resultMarkdown":"..."} completes the work; \`POST ${base}/fail\` {"errorMessage":"..."} reports an execution failure.`,
      `   For a controlled stop, \`POST ${base}/release\` so another executor can claim it.`,
      `   Completing posts your result into the conversation.`,
      "",
      `Without API access, the context refs above are Threa-internal pointers you cannot resolve.`,
      `ask the requester to paste their content, and when the work is finished tell them so they`,
      `can press "Mark done" on the delegation card.`
    )
  }
  return parts.join("\n")
}

/**
 * Timeline card for `delegation:created`. One action list drives the desktop
 * quick toolbar, overflow/right-click menus, and mobile long-press drawer. Copy
 * prompt stays on the mobile card and confirms in place (INV-63/21). Status
 * patches remain authoritative; local flips only fast-path the clicker's action.
 */
export function DelegationEvent({ event, workspaceId, streamId, statusPatch, isThreadParent }: DelegationEventProps) {
  const { getActorName } = useActors(workspaceId)
  const { getPanelUrl } = usePanel()
  const queryClient = useQueryClient()
  // Healing (chunk-2) lands thread stats on the card's own payload once a thread
  // exists, keyed on this event's id — the same anchor the thread was created on.
  const payload = event.payload as
    | (DelegationCreatedEventPayload & { threadId?: string; replyCount?: number; threadSummary?: ThreadSummary })
    | undefined
  // Shared thread affordance, keyed on the card's canonical id (its event id) —
  // the anchor delegation completion threads on. `replyUrl` points at the real
  // thread when one exists, else the draft panel for starting one.
  const { threadHref, replyUrl } = useThreadAnchor(streamId, event.id, { threadId: payload?.threadId })
  const [optimisticallyCancelled, setOptimisticallyCancelled] = useState(false)
  const [optimisticallyDone, setOptimisticallyDone] = useState(false)
  const [optimisticallyRequeued, setOptimisticallyRequeued] = useState(false)
  const requeuePatchSignatureRef = useRef<string | undefined>(undefined)
  const [cancelling, setCancelling] = useState(false)
  const [markingDone, setMarkingDone] = useState(false)
  const [requeueing, setRequeueing] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const actionSurface = useTimelineCardActionSurface()

  const statusPatchSignature = delegationPatchSignature(statusPatch)
  useEffect(() => {
    if (optimisticallyRequeued && statusPatchSignature !== requeuePatchSignatureRef.current) {
      setOptimisticallyRequeued(false)
    }
  }, [optimisticallyRequeued, statusPatchSignature])

  if (!payload) return null

  let status: DelegationStatus = statusPatch?.status ?? DelegationStatuses.OPEN
  if (optimisticallyDone) status = DelegationStatuses.COMPLETED
  else if (optimisticallyCancelled) status = DelegationStatuses.CANCELLED
  else if (optimisticallyRequeued) status = DelegationStatuses.OPEN
  const terminal = DELEGATION_TERMINAL.has(status)
  const optimisticFlip = optimisticallyCancelled || optimisticallyDone || optimisticallyRequeued
  const actorName = getActorName(event.actorId, event.actorType)

  let availabilityLabel = delegationAvailabilityLabel(status, statusPatch?.reason)
  if (optimisticallyRequeued) availabilityLabel = DELEGATION_REOPEN_REASON_LABEL.requeued
  const metaParts = [`${actorName} · ${availabilityLabel}`]
  if (statusPatch?.claimedByLabel && !optimisticFlip) metaParts.push(statusPatch.claimedByLabel)
  const statusNote = !optimisticFlip ? statusPatch?.statusNote : null

  // "View result" target. New completions carry `threadStreamId` — the result
  // lives in a thread anchored on this card, so open that thread panel. Legacy
  // completions have only `resultMessageId` (a synthetic anchor message), which
  // still deep-links via `?m=`. Both are navigation (INV-40).
  const completed = status === DelegationStatuses.COMPLETED
  const threadStreamId = completed ? (statusPatch?.threadStreamId ?? undefined) : undefined
  const legacyResultMessageId = completed && !threadStreamId ? (statusPatch?.resultMessageId ?? undefined) : undefined
  let viewResultHref: string | null = null
  if (!isThreadParent && threadStreamId) viewResultHref = getPanelUrl(threadStreamId)
  else if (!isThreadParent && legacyResultMessageId)
    viewResultHref = `/w/${workspaceId}/s/${streamId}?m=${legacyResultMessageId}`

  const replyCount = payload.replyCount ?? 0

  const hasThread = !!payload.threadId || replyCount > 0
  const promptText = () => buildDelegationPrompt(payload, { workspaceId, origin: window.location.origin })

  async function handleCopy() {
    if (!payload) return
    try {
      await navigator.clipboard.writeText(promptText())
    } catch {
      toast.error("Couldn't copy the prompt")
      return
    }
    setCopyDone(true)
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyDone(false), 1200)
  }

  async function handleCopyLink() {
    if (!payload) return
    try {
      await navigator.clipboard.writeText(buildDelegationLink(workspaceId, payload.delegationId))
      toast.success("Delegation link copied") // INV-63-allow: closing menu/drawer leaves no inline trigger
    } catch {
      toast.error("Couldn't copy the link")
    }
  }

  async function handleRequeue() {
    if (!payload || requeueing || status !== DelegationStatuses.EXPIRED) return
    setRequeueing(true)
    try {
      const { requeued } = await delegationsApi.requeue(workspaceId, payload.delegationId)
      if (requeued) {
        requeuePatchSignatureRef.current = statusPatchSignature
        setOptimisticallyRequeued(true)
      } else {
        toast.info("This delegation is no longer expired")
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: delegationKeys.all }),
        queryClient.invalidateQueries({ queryKey: agentOutcomeKeys.all }),
      ])
    } catch {
      toast.error("Couldn't requeue the delegation")
    } finally {
      setRequeueing(false)
    }
  }

  async function handleMarkDone() {
    if (!payload || markingDone || terminal) return
    setMarkingDone(true)
    try {
      const { completed } = await delegationsApi.markDone(workspaceId, payload.delegationId)
      if (completed) {
        setOptimisticallyDone(true)
      } else {
        toast.info("This delegation already finished or was cancelled")
      }
    } catch {
      toast.error("Couldn't mark the delegation done")
    } finally {
      setMarkingDone(false)
    }
  }

  async function handleCancel() {
    if (!payload || cancelling || terminal) return
    setCancelling(true)
    try {
      const { cancelled: didCancel } = await delegationsApi.cancel(workspaceId, payload.delegationId)
      if (didCancel) {
        setOptimisticallyCancelled(true)
      } else {
        // Lost the race (completed/failed/cancelled elsewhere). Don't
        // flip — the authoritative patch will land with what actually happened.
        toast.info("This delegation already finished or was cancelled")
      }
    } catch {
      toast.error("Couldn't cancel the delegation")
    } finally {
      setCancelling(false)
    }
  }

  const actions: TimelineCardAction[] = []
  if (viewResultHref) {
    actions.push({
      id: "view-result",
      label: "View result",
      icon: ArrowUpRight,
      href: viewResultHref,
      quick: !!threadStreamId,
    })
  }
  if (!isThreadParent && !threadStreamId) {
    actions.push({
      id: "thread",
      label: hasThread ? "Open thread" : "Discuss in thread",
      icon: MessageSquareReply,
      href: replyUrl,
      quick: true,
    })
  }
  actions.push(
    {
      id: "copy-prompt",
      label: copyDone ? "Prompt copied" : "Copy prompt",
      icon: copyDone ? Check : Copy,
      onSelect: handleCopy,
      quick: true,
      separatorBefore: actions.length > 0,
    },
    { id: "copy-link", label: "Copy delegation link", icon: Link2, onSelect: handleCopyLink },
    {
      id: "toggle-prompt",
      label: briefOpen ? "Hide hand-off prompt" : "Show hand-off prompt",
      icon: FileText,
      onSelect: () => setBriefOpen((open) => !open),
    }
  )
  if (status === DelegationStatuses.EXPIRED) {
    actions.push({
      id: "requeue",
      label: requeueing ? "Requeuing…" : "Requeue",
      icon: requeueing ? Loader2 : RotateCcw,
      onSelect: handleRequeue,
      disabled: requeueing,
      loading: requeueing,
      separatorBefore: true,
    })
  }
  if (!terminal) {
    actions.push(
      {
        id: "mark-done",
        label: markingDone ? "Marking done…" : "Mark done",
        icon: markingDone ? Loader2 : Check,
        onSelect: handleMarkDone,
        disabled: markingDone,
        loading: markingDone,
        separatorBefore: true,
      },
      {
        id: "cancel",
        label: cancelling ? "Cancelling…" : "Cancel delegation",
        icon: cancelling ? Loader2 : X,
        onSelect: handleCancel,
        disabled: cancelling,
        loading: cancelling,
        variant: "destructive",
      }
    )
  }

  const card = (
    <div
      className={cn(
        "group reveal-host relative px-3 py-1.5 sm:px-6",
        actionSurface.isTouchInput && "select-none",
        actionSurface.longPress.isPressed && "opacity-70 transition-opacity duration-100"
      )}
      {...(actionSurface.touchCapable ? actionSurface.longPress.handlers : {})}
    >
      <div
        className={cn(
          "rounded-[10px] border px-3 py-2 transition-colors",
          terminal ? "border-border/60 bg-muted/20" : "border-border bg-muted/40",
          status === DelegationStatuses.EXPIRED && "border-primary/35 bg-primary/[0.04]"
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
                status === DelegationStatuses.CANCELLED ? "text-muted-foreground line-through" : "text-foreground/90"
              )}
            >
              {payload.title}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{metaParts.join(" · ")}</p>
          </div>

          {/* Copy remains a persistent, finger-sized mobile affordance. Every
              other action lives in the long-press drawer; desktop gets the
              message-style hover toolbar + overflow menu. */}
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copyDone ? "Prompt copied" : "Copy prompt"}
            aria-live="polite"
            title="Copy the hand-off prompt for a local agent"
            className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-muted sm:hidden"
          >
            {copyDone ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>

        {statusNote && <p className="mt-1.5 pl-10 text-[11px] text-muted-foreground">{statusNote}</p>}

        <button
          type="button"
          onClick={() => setBriefOpen((open) => !open)}
          aria-expanded={briefOpen}
          className="mt-1.5 hidden items-center gap-1 pl-10 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
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
              {promptText()}
            </pre>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Give this prompt to an executor. With a Threa API key, it can inspect the task, claim it if accepted, and
              update this card. Otherwise press Mark done when the work is finished.
            </p>
          </div>
        )}
      </div>

      {/* Thread anchored on this card — surfaces the discussion (and a completed
          delegation's result) as a footer chip once replies land. Keyed on the
          card's event id via `useThreadAnchor`; healed payload drives the count.
          Suppressed when the card IS the thread parent (chip would link to the
          panel already open). */}
      {!isThreadParent && (
        <ThreadSlot
          replyCount={replyCount}
          threadHref={threadHref}
          summary={payload.threadSummary}
          workspaceId={workspaceId}
        />
      )}
      <TimelineCardQuickActions actions={actions} />
    </div>
  )

  return (
    <>
      <TimelineCardContextMenu actions={actions} disabled={actionSurface.isTouchInput}>
        {card}
      </TimelineCardContextMenu>
      {actionSurface.touchCapable && (
        <TimelineCardActionDrawer
          open={actionSurface.drawerOpen}
          onOpenChange={actionSurface.setDrawerOpen}
          actions={actions}
          title={payload.title}
          subtitle={metaParts.join(" · ")}
        />
      )}
    </>
  )
}
