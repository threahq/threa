import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ArrowUpRight,
  Check,
  CircleX,
  Clock,
  CornerUpLeft,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  X,
} from "lucide-react"
import {
  SubagentStatuses,
  type StreamEvent,
  type SubagentCreatedEventPayload,
  type SubagentStatus,
  type SubagentStatusChangedEventPayload,
  type SubagentSummary,
  type ThreadSummary,
} from "@threa/types"
import { subagentsApi } from "@/api"
import { usePanel } from "@/contexts"
import { useActors } from "@/hooks"
import type { MessageAgentActivity } from "@/hooks"
import { agentOutcomeKeys } from "@/hooks/use-agent-outcomes"
import { formatRelativeTime, formatTime } from "@/lib/dates"
import { modelDisplayName } from "@/lib/model-display"
import { getStepInlineLabel } from "@/lib/step-config"
import {
  resolveSubagentCardState,
  subagentFailureLabel,
  subagentStateAnimates,
  subagentStatePillClass,
  SUBAGENT_STATE_LABEL,
  SUBAGENT_TERMINAL,
  type SubagentCardState,
} from "@/lib/subagent-display"
import { cn } from "@/lib/utils"
import {
  TimelineCardActionDrawer,
  TimelineCardContextMenu,
  TimelineCardQuickActions,
  type TimelineCardAction,
  useTimelineCardActionSurface,
} from "./timeline-card-actions"

/** Healed thread stats ride alongside the created payload on the card event. */
type SubagentCardPayload = SubagentCreatedEventPayload & {
  threadId?: string
  replyCount?: number
  threadSummary?: ThreadSummary
}

interface SubagentEventProps {
  event: StreamEvent
  workspaceId: string
  /**
   * The latest `subagent:status_changed` EVENT for this run within the loaded
   * window — the whole event, not just its payload, because the card reports who
   * ended the run and when, which only the event row carries.
   */
  statusPatch?: StreamEvent
  /**
   * The authoritative run, used ONLY when no patch is in reach — the card pinned
   * atop its own thread, opened by deep link. It carries no actor, so a
   * transition read from it names the state without naming who drove it.
   */
  runFallback?: SubagentSummary
  /**
   * The live session in the subagent's thread, aliased under this card's event id
   * by `useAgentActivity` (a thread's activity lights up its anchor). Present
   * only while a turn is actually running.
   */
  activity?: MessageAgentActivity
  /** True when this card is pinned atop its OWN thread panel — the link would loop back. */
  isThreadParent?: boolean
}

const STATE_ICON = {
  working: Loader2,
  starting: Loader2,
  waiting: MessageCircleQuestion,
  completed: Check,
  failed: CircleX,
  cancelled: X,
  expired: Clock,
} as const satisfies Record<SubagentCardState, typeof Check>

/**
 * Timeline card for `subagent:created`: one geometry for all five states — a
 * 28px tile, two truncating text lines, one pill — so the row can never resize
 * as the run moves (INV-21 by construction, held by the equal-height test in
 * `subagent-event.test.tsx`). Only the colors, the glyph and the words change.
 *
 * The whole card is a link to the subagent's thread (INV-40); every action lives
 * in the hover toolbar / long-press drawer, never in the flow.
 */
export function SubagentEvent({
  event,
  workspaceId,
  statusPatch,
  runFallback,
  activity,
  isThreadParent,
}: SubagentEventProps) {
  const { getActorName } = useActors(workspaceId)
  const { getPanelUrl } = usePanel()
  const queryClient = useQueryClient()
  const [optimisticallyCancelled, setOptimisticallyCancelled] = useState(false)
  const [optimisticallyRequeued, setOptimisticallyRequeued] = useState(false)
  const requeuePatchIdRef = useRef<string | undefined>(undefined)
  const [cancelling, setCancelling] = useState(false)
  const [requeueing, setRequeueing] = useState(false)
  const actionSurface = useTimelineCardActionSurface()

  // A newer patch than the one the requeue raced supersedes the local flip: the
  // server's word is always the one on screen.
  useEffect(() => {
    if (optimisticallyRequeued && statusPatch?.id !== requeuePatchIdRef.current) setOptimisticallyRequeued(false)
  }, [optimisticallyRequeued, statusPatch?.id])

  const payload = event.payload as SubagentCardPayload | undefined
  if (!payload) return null

  const patchPayload = statusPatch?.payload as SubagentStatusChangedEventPayload | undefined
  const settled: { status: SubagentStatus; statusNote?: string | null } | undefined =
    patchPayload ?? (runFallback ? { status: runFallback.status, statusNote: runFallback.statusNote } : undefined)
  let status: SubagentStatus = settled?.status ?? SubagentStatuses.ACTIVE
  if (optimisticallyCancelled) status = SubagentStatuses.CANCELLED
  else if (optimisticallyRequeued) status = SubagentStatuses.ACTIVE
  const optimisticFlip = optimisticallyCancelled || optimisticallyRequeued

  const state = resolveSubagentCardState({
    status,
    hasLiveSession: !!activity && !optimisticFlip,
    lastAgentMessageAt: optimisticFlip ? null : patchPayload?.lastAgentMessageAt,
    threadSummary: payload.threadSummary,
  })
  const terminal = SUBAGENT_TERMINAL.has(status)

  const modelLabel = modelDisplayName(payload.model)
  const replyCount = payload.replyCount ?? 0
  const replies = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : null
  const patchAt = statusPatch ? new Date(statusPatch.createdAt) : null

  const metaParts: Array<string | null> = []
  switch (state) {
    case "working":
      metaParts.push(modelLabel, activity ? (activity.substep ?? getStepInlineLabel(activity.currentStepType)) : null)
      break
    case "starting":
      // Nothing is running: say when the subagent last spoke, or that it has yet
      // to. Never a phase — there is no session to have one.
      metaParts.push(
        modelLabel,
        patchPayload?.lastAgentMessageAt
          ? formatRelativeTime(new Date(patchPayload.lastAgentMessageAt), new Date(), undefined, { terse: true })
          : "starting…"
      )
      break
    case "waiting":
      metaParts.push(
        `${modelLabel} asked a question`,
        patchPayload?.lastAgentMessageAt
          ? formatRelativeTime(new Date(patchPayload.lastAgentMessageAt), new Date(), undefined, { terse: true })
          : null,
        replies
      )
      break
    case "completed":
      metaParts.push(
        modelLabel,
        patchAt ? `finished ${formatRelativeTime(patchAt, new Date(), undefined, { terse: true })}` : null,
        replies
      )
      break
    case "failed":
      metaParts.push(modelLabel, subagentFailureLabel(patchPayload?.statusNote))
      break
    case "cancelled":
      metaParts.push(
        `Cancelled by ${getActorName(statusPatch?.actorId ?? null, statusPatch?.actorType ?? null)}`,
        patchAt ? formatTime(patchAt) : null
      )
      break
    case "expired":
      metaParts.push(modelLabel, "idle too long")
      break
  }
  const meta = metaParts.filter((part): part is string => !!part).join(" · ")

  const threadHref = isThreadParent ? null : getPanelUrl(payload.threadStreamId)

  async function handleCancel() {
    if (!payload || cancelling || terminal) return
    setCancelling(true)
    try {
      const { cancelled } = await subagentsApi.cancel(workspaceId, payload.subagentId)
      // Lost the race (reported back, failed, expired elsewhere) — don't flip;
      // the authoritative patch lands with whatever actually happened.
      if (cancelled) setOptimisticallyCancelled(true)
      else toast.info("This subagent already finished")
      await queryClient.invalidateQueries({ queryKey: agentOutcomeKeys.all })
    } catch {
      toast.error("Couldn't cancel the subagent")
    } finally {
      setCancelling(false)
    }
  }

  async function handleRequeue() {
    if (!payload || requeueing || !terminal) return
    setRequeueing(true)
    try {
      const { requeued } = await subagentsApi.requeue(workspaceId, payload.subagentId)
      if (requeued) {
        requeuePatchIdRef.current = statusPatch?.id
        setOptimisticallyRequeued(true)
      } else {
        toast.info("This subagent is no longer failed or expired")
      }
      await queryClient.invalidateQueries({ queryKey: agentOutcomeKeys.all })
    } catch (error) {
      // The stream's one live slot was taken while this card sat on screen.
      const conflict = (error as { code?: string })?.code === "SUBAGENT_ALREADY_ACTIVE"
      if (conflict) toast.info("Another subagent is already running in this stream")
      else toast.error("Couldn't restart the subagent")
    } finally {
      setRequeueing(false)
    }
  }

  const actions: TimelineCardAction[] = []
  if (threadHref) {
    if (state === "waiting") {
      actions.push({ id: "answer", label: "Answer in thread", icon: CornerUpLeft, href: threadHref, quick: true })
    } else if (state === "completed") {
      actions.push({ id: "view-result", label: "View result", icon: ArrowUpRight, href: threadHref, quick: true })
    } else {
      actions.push({ id: "thread", label: "Open thread", icon: CornerUpLeft, href: threadHref, quick: true })
    }
  }
  if (state === "failed" || state === "expired") {
    actions.push({
      id: "requeue",
      label: requeueing ? "Restarting…" : "Try again",
      icon: requeueing ? Loader2 : RotateCcw,
      onSelect: handleRequeue,
      disabled: requeueing,
      loading: requeueing,
      quick: true,
      separatorBefore: actions.length > 0,
    })
  }
  if (!terminal) {
    actions.push({
      id: "cancel",
      label: cancelling ? "Cancelling…" : "Cancel subagent",
      icon: cancelling ? Loader2 : X,
      onSelect: handleCancel,
      disabled: cancelling,
      loading: cancelling,
      variant: "destructive",
      separatorBefore: actions.length > 0,
    })
  }

  const Icon = STATE_ICON[state]
  const pillLabel = SUBAGENT_STATE_LABEL[state]

  // One layout for every state: tile, two lines, pill. No conditional rows —
  // a card that can't grow can't shift the timeline under the reader.
  const body = (
    <>
      <span
        data-testid="subagent-tile"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
          state === "waiting" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className={cn("h-4 w-4", subagentStateAnimates(state) && "animate-spin")} aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[13px] font-medium",
            state === "cancelled" ? "text-muted-foreground line-through" : "text-foreground/90"
          )}
        >
          {payload.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</p>
      </div>

      <span
        className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", subagentStatePillClass(state))}
      >
        {pillLabel}
      </span>
    </>
  )

  const surfaceClass = cn(
    "flex items-center gap-3 rounded-[10px] border px-3 py-2 transition-colors",
    terminal ? "border-border/60 bg-muted/20" : "border-border bg-muted/40",
    state === "waiting" && "border-primary/35 bg-primary/[0.06]"
  )

  const card = (
    <div
      className={cn(
        "group reveal-host relative px-3 py-1.5 sm:px-6",
        actionSurface.isTouchInput && "select-none",
        actionSurface.longPress.isPressed && "opacity-70 transition-opacity duration-100"
      )}
      {...(actionSurface.touchCapable ? actionSurface.longPress.handlers : {})}
    >
      {threadHref ? (
        <Link
          to={threadHref}
          draggable={false}
          aria-label={`${payload.title} — ${pillLabel}`}
          className={cn(surfaceClass, "hover:border-border hover:bg-muted/60")}
        >
          {body}
        </Link>
      ) : (
        <div className={surfaceClass}>{body}</div>
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
          subtitle={meta}
        />
      )}
    </>
  )
}
