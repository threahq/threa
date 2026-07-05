import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Check, X, Loader2 } from "lucide-react"
import type {
  StreamEvent,
  AgentSessionRerunContext,
  AgentSessionStartedPayload,
  AgentSessionCompletedPayload,
  AgentSessionFailedPayload,
  AgentSessionDeletedPayload,
} from "@threa/types"
import { useTrace } from "@/contexts"
import { RelativeTime } from "@/components/relative-time"
import { formatDuration } from "@/lib/dates"
import { StopSessionButton, RedirectSessionButton } from "@/components/trace/session-action-buttons"
import { focusVisibleZoneEditor } from "./message-event"

/** How long the Redirect hint replaces the subtitle line after a click. */
const REDIRECT_HINT_MS = 5000

interface AgentSessionEventProps {
  events: StreamEvent[]
  sessionVersion?: number
  /** Live progress counts from parent (via useAgentActivity hook) */
  liveCounts?: { stepCount: number; messageCount: number }
  /**
   * Latest live substep text (e.g. "Planning queries…") emitted by a long-running
   * tool. Shown in place of the generic step label when present.
   */
  liveSubstep?: string | null
  /** Click handler for the Stop button, rendered while the session is running. */
  onStopSession?: (sessionId: string) => void
}

type SessionStatus = "running" | "completed" | "failed" | "deleted"

interface StatusConfig {
  title: string
  subtitle: string
  icon: React.ReactNode
  borderColor: string
  bgColor: string
  hoverBgColor: string
  titleColor?: string
  timestamp: string | null
}

function deriveStatus(events: StreamEvent[]): {
  status: SessionStatus
  sessionId: string
  startedPayload: AgentSessionStartedPayload | null
  completedPayload: AgentSessionCompletedPayload | null
  failedPayload: AgentSessionFailedPayload | null
  deletedPayload: AgentSessionDeletedPayload | null
} {
  let startedPayload: AgentSessionStartedPayload | null = null
  let completedPayload: AgentSessionCompletedPayload | null = null
  let failedPayload: AgentSessionFailedPayload | null = null
  let deletedPayload: AgentSessionDeletedPayload | null = null
  let sessionId = ""

  for (const event of events) {
    const payload = event.payload as { sessionId?: string }
    if (payload.sessionId) sessionId = payload.sessionId

    switch (event.eventType) {
      case "agent_session:started":
        startedPayload = event.payload as AgentSessionStartedPayload
        break
      case "agent_session:completed":
        completedPayload = event.payload as AgentSessionCompletedPayload
        break
      case "agent_session:failed":
        failedPayload = event.payload as AgentSessionFailedPayload
        break
      case "agent_session:deleted":
        deletedPayload = event.payload as AgentSessionDeletedPayload
        break
    }
  }

  // Deleted takes precedence over completed/failed because it is a terminal superseding action.
  // Completed takes precedence over failed (intermediate failures can be recovered).
  let status: SessionStatus
  if (deletedPayload) {
    status = "deleted"
  } else if (completedPayload) {
    status = "completed"
  } else if (failedPayload) {
    status = "failed"
  } else {
    status = "running"
  }

  return { status, sessionId, startedPayload, completedPayload, failedPayload, deletedPayload }
}

function buildStatusConfig(
  status: SessionStatus,
  startedPayload: AgentSessionStartedPayload | null,
  completedPayload: AgentSessionCompletedPayload | null,
  failedPayload: AgentSessionFailedPayload | null,
  deletedPayload: AgentSessionDeletedPayload | null,
  liveCounts: { stepCount: number; messageCount: number } | undefined
): StatusConfig {
  const rerunReasonLabel = formatRerunReasonLabel(startedPayload?.rerunContext)
  const rerunReasonDetail = formatRerunReasonDetail(startedPayload?.rerunContext)

  switch (status) {
    case "deleted":
      return {
        title: "Session deleted",
        subtitle: "This session was removed because its invoking message was deleted.",
        icon: (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(210_15%_55%/0.15)]">
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
        ),
        borderColor: "hsl(var(--border))",
        bgColor: "hsl(var(--muted) / 0.4)",
        hoverBgColor: "hsl(var(--muted) / 0.6)",
        timestamp: deletedPayload?.deletedAt ?? startedPayload?.startedAt ?? null,
      }

    case "completed": {
      const parts: string[] = []
      if (rerunReasonLabel) {
        parts.push(rerunReasonLabel)
      }
      if (rerunReasonDetail) {
        parts.push(rerunReasonDetail)
      }
      if (completedPayload) {
        parts.push(`${completedPayload.stepCount} ${completedPayload.stepCount === 1 ? "step" : "steps"}`)
        parts.push(formatDuration(completedPayload.duration))
        parts.push(
          `${completedPayload.messageCount} ${completedPayload.messageCount === 1 ? "message" : "messages"} sent`
        )
      }
      return {
        title: "Session complete",
        subtitle: parts.join(" • "),
        icon: (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(142_76%_36%/0.15)]">
            <Check className="w-3.5 h-3.5 text-[hsl(142,76%,36%)]" />
          </div>
        ),
        borderColor: "hsl(var(--border))",
        bgColor: "hsl(var(--muted) / 0.5)",
        hoverBgColor: "hsl(var(--muted) / 0.7)",
        timestamp: completedPayload?.completedAt ?? startedPayload?.startedAt ?? null,
      }
    }
    case "failed": {
      const parts: string[] = []
      if (rerunReasonLabel) {
        parts.push(rerunReasonLabel)
      }
      if (rerunReasonDetail) {
        parts.push(rerunReasonDetail)
      }
      if (failedPayload) {
        parts.push(`${failedPayload.stepCount} ${failedPayload.stepCount === 1 ? "step" : "steps"}`)
      }
      parts.push("Error during execution")
      return {
        title: "Session failed",
        subtitle: parts.join(" • "),
        icon: (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(0_84%_60%/0.15)]">
            <X className="w-3.5 h-3.5 text-[hsl(0,84%,60%)]" />
          </div>
        ),
        borderColor: "hsl(0 84% 60% / 0.3)",
        bgColor: "hsl(0 84% 60% / 0.05)",
        hoverBgColor: "hsl(0 84% 60% / 0.08)",
        titleColor: "hsl(0 84% 60%)",
        timestamp: failedPayload?.failedAt ?? startedPayload?.startedAt ?? null,
      }
    }
    case "running": {
      const personaName = startedPayload?.personaName ?? "Agent"
      const stepCount = liveCounts?.stepCount ?? 0
      const messageCount = liveCounts?.messageCount ?? 0
      // Note: liveSubstep is intentionally NOT joined into the meta string — the
      // render function promotes it into its own row with a live-pulse dot and
      // italic foreground weight, so it stands out as "what is happening right now"
      // instead of being buried among static counts.
      const parts: string[] = []
      if (rerunReasonLabel) {
        parts.push(rerunReasonLabel)
      }
      if (rerunReasonDetail) {
        parts.push(rerunReasonDetail)
      }
      parts.push(`${stepCount} ${stepCount === 1 ? "step" : "steps"}`)
      parts.push(`${messageCount} ${messageCount === 1 ? "message" : "messages"} sent`)
      return {
        title: `${personaName} is working…`,
        subtitle: parts.join(" • "),
        icon: (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(var(--primary)/0.15)]">
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          </div>
        ),
        borderColor: "hsl(var(--border))",
        bgColor: "hsl(var(--muted) / 0.5)",
        hoverBgColor: "hsl(var(--muted) / 0.7)",
        timestamp: startedPayload?.startedAt ?? null,
      }
    }
  }
}

function formatRerunReasonLabel(rerunContext?: AgentSessionRerunContext | null): string | null {
  if (!rerunContext) return null
  switch (rerunContext.cause) {
    case "invoking_message_edited":
      return "Rerun after invoking message edit"
    case "referenced_message_edited":
      return "Rerun after follow-up message edit"
    default:
      return null
  }
}

function formatRerunReasonDetail(rerunContext?: AgentSessionRerunContext | null): string | null {
  if (!rerunContext) return null
  const after = rerunContext.editedMessageAfter?.trim()
  if (!after) return null
  const compact = after.length > 80 ? `${after.slice(0, 77)}...` : after
  return `Edited: "${compact}"`
}

export function AgentSessionEvent({
  events,
  sessionVersion,
  liveCounts,
  liveSubstep,
  onStopSession,
}: AgentSessionEventProps) {
  const { getTraceUrl } = useTrace()
  const { status, sessionId, startedPayload, completedPayload, failedPayload, deletedPayload } = deriveStatus(events)

  const config = buildStatusConfig(status, startedPayload, completedPayload, failedPayload, deletedPayload, liveCounts)

  const [redirectHintVisible, setRedirectHintVisible] = useState(false)
  const redirectHintTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (redirectHintTimer.current !== null) window.clearTimeout(redirectHintTimer.current)
    },
    []
  )

  if (!sessionId) return null

  // Redirect needs no backend call: the runtime already folds mid-run messages
  // into the running session (NewMessageAwareness → reconsidering). The button
  // just pulls the cursor into this surface's composer and hints at what
  // typing will do.
  const handleRedirect = (e: React.MouseEvent<HTMLButtonElement>) => {
    focusVisibleZoneEditor(e.currentTarget.closest<HTMLElement>("[data-editor-zone]"))
    if (redirectHintTimer.current !== null) window.clearTimeout(redirectHintTimer.current)
    setRedirectHintVisible(true)
    redirectHintTimer.current = window.setTimeout(() => setRedirectHintVisible(false), REDIRECT_HINT_MS)
  }

  // Stop and Redirect are gated on "session running", not on which tool is
  // active — the backend aborts the whole session gracefully regardless
  // (roadmap 2.1), so the buttons stay stable for the entire run (INV-21).
  const showSessionActions = status === "running"
  const showRedirectHint = showSessionActions && redirectHintVisible
  const showLiveSubstep = status === "running" && !!liveSubstep
  const personaName = startedPayload?.personaName ?? "The agent"

  return (
    <div className="py-3">
      <Link
        to={getTraceUrl(sessionId)}
        className="group flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] text-[13px] transition-all duration-150 no-underline"
        style={{
          background: config.bgColor,
          border: `1px solid ${config.borderColor}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = config.hoverBgColor
          if (status === "completed") {
            e.currentTarget.style.borderColor = "hsl(var(--primary) / 0.3)"
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = config.bgColor
          e.currentTarget.style.borderColor = config.borderColor
        }}
      >
        {config.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-medium" style={config.titleColor ? { color: config.titleColor } : undefined}>
              {config.title}
            </div>
            {sessionVersion != null && sessionVersion > 1 && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Version {sessionVersion}
              </span>
            )}
          </div>
          {/*
            INV-21: subtitle is always a single line so the card height never shifts
            when a live substep arrives or disappears. When a substep is present we
            show it as the primary (italic foreground) with a leading radar-pulse dot
            signalling "what is actually happening right now"; the static counts drop
            to a secondary `shrink-0` chip on the right of the same line, truncating
            the substep first if the container runs out of space. The `key` on the
            substep span re-triggers the fade-in whenever the phase text changes, so
            the user sees a visible "tick" as research advances.
          */}
          {/*
            The Redirect hint borrows the same single line for its short window
            (still no height change, INV-21) and then yields back to the
            substep/subtitle.
          */}
          {showRedirectHint && (
            <div className="mt-0.5 min-w-0 truncate text-[11px] italic text-primary/90 animate-in fade-in-50 duration-200">
              {personaName} will fold your message into the current work
            </div>
          )}
          {!showRedirectHint && showLiveSubstep && (
            <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-[11px]">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5 shrink-0">
                <span className="absolute inset-0 rounded-full bg-primary opacity-60 animate-activity-pulse" />
                <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <span
                key={liveSubstep}
                className="min-w-0 flex-1 truncate italic text-foreground/90 animate-in fade-in-50 duration-200"
              >
                {liveSubstep}
              </span>
              {config.subtitle && (
                <>
                  <span aria-hidden className="shrink-0 text-muted-foreground/40">
                    ·
                  </span>
                  <span className="shrink-0 text-muted-foreground/70">{config.subtitle}</span>
                </>
              )}
            </div>
          )}
          {!showRedirectHint && !showLiveSubstep && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{config.subtitle || "\u00a0"}</div>
          )}
        </div>
        {/*
          Right-slot arbitration: while the session runs, the Redirect/Stop pair
          owns the right edge (always visible, not a hover-reveal) — stable for
          the whole run so nothing pops in or out as steps change (INV-21).
          Otherwise the existing timestamp / "Show trace and sources →" hover
          hint lives there.
        */}
        {showSessionActions ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <RedirectSessionButton onClick={handleRedirect} stopPropagation />
            {onStopSession && <StopSessionButton onClick={() => onStopSession(sessionId)} stopPropagation />}
          </div>
        ) : (
          <div className="shrink-0 text-[11px]">
            {config.timestamp && (
              <RelativeTime date={config.timestamp} className="text-muted-foreground group-hover:hidden" />
            )}
            <span className="text-primary hidden group-hover:inline">Show trace and sources →</span>
          </div>
        )}
      </Link>
    </div>
  )
}
