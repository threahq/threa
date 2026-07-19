import { useEffect, useState } from "react"
import { Phone, Video } from "lucide-react"
import type { CallEndedEventPayload, CallStartedEventPayload, StreamEvent } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useActors } from "@/hooks"
import { useActiveCall } from "@/stores/active-calls-store"
import { useCallLaunch } from "@/components/call/call-launch-context"
import { useCallPhase, useCallStreamId } from "@/components/call/call-store-hooks"
import { cn } from "@/lib/utils"

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
export function CallCard({ event, workspaceId, streamId, endedPatch }: CallCardProps) {
  const payload = event.payload as CallStartedEventPayload | undefined
  const live = useActiveCall(workspaceId, payload?.callId)
  const { launch, callActive } = useCallLaunch()
  const callPhase = useCallPhase()
  const inCallStreamId = useCallStreamId()

  if (!payload) return null

  const ModeIcon = payload.mode === "audio_only" ? Phone : Video
  const isLive = live !== null
  // The viewer is already in THIS call (one active call per stream) when a call
  // is up and their local session is on this stream.
  const selfInThisCall = callPhase !== "idle" && inCallStreamId === streamId

  return (
    <div className="px-3 sm:px-6 py-1.5">
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

        {isLive &&
          (selfInThisCall ? (
            <span className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground">
              In this call
            </span>
          ) : (
            <button
              type="button"
              onClick={() => launch({ workspaceId, streamId, mode: payload.mode, expectedCallId: payload.callId })}
              disabled={callActive}
              title={callActive ? "You're already in another call" : undefined}
              className={cn(
                "shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors",
                callActive ? "opacity-50" : "hover:bg-primary/90"
              )}
            >
              Join
            </button>
          ))}
      </div>
    </div>
  )
}
