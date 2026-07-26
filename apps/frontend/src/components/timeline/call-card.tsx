import { useEffect, useState } from "react"
import { Link2, LogIn, MessageSquareReply, Phone, PhoneForwarded, Video } from "lucide-react"
import { toast } from "sonner"
import type { CallEndedEventPayload, CallStartedEventPayload, StreamEvent, ThreadSummary } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useActors } from "@/hooks"
import { useActiveCall } from "@/stores/active-calls-store"
import { useCallLaunch } from "@/components/call/call-launch-context"
import { useCallPhase, useCallStreamId } from "@/components/call/call-store-hooks"
import { useCallOnAnotherDevice } from "@/components/call/use-call-on-another-device"
import { buildStreamLink } from "@/lib/stream-links"
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

interface CallCardProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  /**
   * The `call_ended` patch for this call within the loaded window — the
   * authoritative end summary, so every viewer sees the same historical card and
   * it survives a reload. Absent while the call is (or was last seen) live.
   */
  endedPatch?: CallEndedEventPayload
  /**
   * True when this card is pinned atop its OWN thread panel as the thread parent.
   * Its thread affordance (footer chip + Chat) would loop back to the panel
   * already open, so it's suppressed here.
   */
  isThreadParent?: boolean
}

/** mm:ss, or h:mm:ss past an hour. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Self-ticking duration leaf (the RelativeTime pattern): owns its own 1s
 * interval and re-renders ONLY itself, so a live call never busts the memoized
 * Virtuoso row (`timelineRowPropsEqual`) or re-measures the list every second.
 * `tabular-nums` + a reserved min-width keep the ticking digits from shifting
 * neighbours (INV-21).
 */
function CallDurationTicker({ startedAt }: { startedAt: string }) {
  const start = Date.parse(startedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const value = Number.isNaN(start) ? "0:00" : formatDuration(now - start)
  return (
    <span className="inline-block min-w-[3.25rem] text-right tabular-nums" aria-label="Call duration">
      {value}
    </span>
  )
}

function ParticipantAvatars({ userIds, workspaceId }: { userIds: string[]; workspaceId: string }) {
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const shown = userIds.slice(0, 4)
  const extra = userIds.length - shown.length
  if (shown.length === 0) return null
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((id) => {
        const info = getActorAvatar(id, "user")
        return (
          <Avatar key={id} className="h-5 w-5 rounded-full border border-background">
            {info.avatarUrl && <AvatarImage src={info.avatarUrl} alt={getActorName(id, "user")} />}
            <AvatarFallback className="rounded-full text-[8px]">{info.fallback}</AvatarFallback>
          </Avatar>
        )
      })}
      {extra > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-background bg-muted px-1 text-[9px] font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  )
}

/**
 * Timeline card for `call_started` (roadmap 1.4). LIVENESS DEFAULTS DEAD: the
 * card renders its live face — joined avatars, a ticking duration, a Join button
 * — ONLY when the active-calls cache confirms a live call with this id. A
 * `call_started` row whose call is no longer live (or was never seen live on this
 * client) renders the ENDED face from the `call_ended` payload, with zero fetch.
 * This inverts the delegation card's "absent patch = still open" default: a stale
 * live card with a Join button on a dead call is an interactive lie.
 *
 * The full card is not a link — the Join button acts (INV-40). Success is silent
 * (INV-63): joining just brings up the dock.
 */
export function CallCard({ event, workspaceId, streamId, endedPatch, isThreadParent }: CallCardProps) {
  // Chunk-2 healing lands thread stats on this event's payload once a thread
  // exists, keyed on the event id — the anchor the call chat threads on.
  const payload = event.payload as
    | (CallStartedEventPayload & { threadId?: string; replyCount?: number; threadSummary?: ThreadSummary })
    | undefined
  const live = useActiveCall(workspaceId, payload?.callId)
  const { launch, callActive } = useCallLaunch()
  const callPhase = useCallPhase()
  const inCallStreamId = useCallStreamId()
  // Shared thread affordance keyed on the card's event id: `replyUrl` opens the
  // real thread when one exists, else the draft panel to start the call chat.
  const { threadHref, replyUrl } = useThreadAnchor(streamId, event.id, { threadId: payload?.threadId })
  // Known before the click, so the affordance says what will actually happen
  // instead of a Join that 409s and then asks.
  const onAnotherDevice = useCallOnAnotherDevice(workspaceId, payload?.callId)
  const actionSurface = useTimelineCardActionSurface()

  if (!payload) return null

  const ModeIcon = payload.mode === "audio_only" ? Phone : Video
  const isLive = live !== null
  // The viewer is already in THIS call (one active call per stream) when a call
  // is up and their local session is on this stream.
  const selfInThisCall = callPhase !== "idle" && inCallStreamId === streamId

  // One live call per stream, so "already in it elsewhere" needs no id match.
  const joinLabel = onAnotherDevice ? "Take over" : "Join"
  const joinTitle = onAnotherDevice ? "Move this call to this device" : undefined
  const join = () =>
    launch({
      workspaceId,
      streamId,
      mode: payload.mode,
      expectedCallId: payload.callId,
      takeover: onAnotherDevice,
    })

  const replyCount = payload.replyCount ?? 0
  const hasThread = !!payload.threadId || replyCount > 0

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(`${buildStreamLink(workspaceId, streamId)}?m=${event.id}`)
      toast.success("Call link copied") // INV-63-allow: closing menu/drawer leaves no inline trigger
    } catch {
      toast.error("Couldn't copy the call link")
    }
  }

  const actions: TimelineCardAction[] = []
  if (isLive && !selfInThisCall) {
    actions.push({
      id: "join",
      label: onAnotherDevice ? "Take over call on this device" : "Join call",
      icon: onAnotherDevice ? PhoneForwarded : LogIn,
      onSelect: join,
      disabled: callActive,
      disabledReason: callActive ? "You're already in another call" : undefined,
    })
  }
  if (!isThreadParent) {
    actions.push({
      id: "thread",
      label: hasThread ? "Open call chat" : "Start call chat",
      icon: MessageSquareReply,
      href: replyUrl,
      quick: true,
    })
  }
  actions.push({
    id: "copy-link",
    label: "Copy link to call",
    icon: Link2,
    onSelect: handleCopyLink,
    separatorBefore: actions.length > 0,
  })

  let subtitle = "Call ended"
  if (isLive) subtitle = "Call in progress"
  else if (endedPatch) subtitle = `Call ended · ${formatDuration(endedPatch.durationMs)}`

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
          "flex items-center gap-3 rounded-[10px] border px-3 py-2 transition-colors",
          isLive ? "border-primary/40 bg-primary/5" : "border-border/60 bg-muted/20"
        )}
      >
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            isLive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          <ModeIcon className="h-4 w-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          {isLive ? (
            <>
              <p className="flex items-center gap-2 text-[13px] font-medium text-foreground/90">
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary animate-activity-pulse"
                  aria-hidden="true"
                />
                Call in progress
                <CallDurationTicker startedAt={payload.startedAt} />
              </p>
              <div className="mt-1">
                <ParticipantAvatars userIds={live.participantUserIds} workspaceId={workspaceId} />
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] font-medium text-muted-foreground">
                {endedPatch ? `Call ended · ${formatDuration(endedPatch.durationMs)}` : "Call ended"}
              </p>
              {endedPatch && endedPatch.participantUserIds.length > 0 && (
                <div className="mt-1">
                  <ParticipantAvatars userIds={endedPatch.participantUserIds} workspaceId={workspaceId} />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isLive &&
            (selfInThisCall ? (
              <span className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground">In this call</span>
            ) : (
              <button
                type="button"
                onClick={join}
                disabled={callActive}
                title={callActive ? "You're already in another call" : joinTitle}
                className={cn(
                  "min-h-9 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors sm:min-h-0",
                  callActive ? "opacity-50" : "hover:bg-primary/90"
                )}
              >
                {joinLabel}
              </button>
            ))}
        </div>
      </div>

      {/* Thread anchored on this card — the call's discussion (and future call
          summary) surfaces as a footer chip once replies land. Keyed on the
          event id via `useThreadAnchor`; healed payload drives the count.
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
          title={payload.mode === "audio_only" ? "Voice call" : "Video call"}
          subtitle={subtitle}
        />
      )}
    </>
  )
}
