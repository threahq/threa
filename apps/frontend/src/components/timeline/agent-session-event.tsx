import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { StreamEvent } from "@threahq/types"
import { useTrace } from "@/contexts"
import { RelativeTime } from "@/components/relative-time"
import { findVisibleZoneEditor, focusAtEnd } from "@/hooks"
import { StopSessionButton, RedirectSessionButton } from "@/components/trace/session-action-buttons"
import { SessionEffectGrid } from "./session-effect-grid"
import { LiveSessionEffectGrid } from "./live-session-effect-grid"
import { useAgentSessionActivity } from "@/stores/agent-activity-store"
import { deriveSessionStatus, buildSessionStatusConfig, sessionEffectsFor } from "./agent-session-status"

/** How long the Redirect hint replaces the subtitle line after a click. */
const REDIRECT_HINT_MS = 5000

interface AgentSessionEventProps {
  events: StreamEvent[]
  workspaceId: string
  sessionVersion?: number
  /** Click handler for the Stop button, rendered while the session is running. */
  onStopSession?: (sessionId: string) => void
  /**
   * Redirect override for surfaces whose composer isn't in the DOM to walk to
   * (the board card, whose reply composer is collapsed until opened): open and
   * focus that composer. When absent, Redirect walks to the nearest
   * `[data-editor-zone]` editor instead (timeline, thread panel).
   */
  onRedirect?: () => void
}

export function AgentSessionEvent({
  events,
  workspaceId,
  sessionVersion,
  onStopSession,
  onRedirect,
}: AgentSessionEventProps) {
  const { getTraceUrl } = useTrace()
  const derived = deriveSessionStatus(events)
  const { status, sessionId, startedPayload } = derived

  // Live counts and phase text arrive as ephemeral `agent_session:*` socket ticks
  // that never reach `events`. Subscribed here, not passed in: a tick then repaints
  // this card alone, instead of every parent that would have to carry it.
  const live = useAgentSessionActivity(workspaceId, sessionId)
  const liveSubstep = live?.substep ?? null

  // A running turn's writes stream onto the card (`LiveSessionEffectGrid`); the
  // lifecycle payloads take over once it settles or retries.
  const { described: describedEffects, markerCount } = sessionEffectsFor(derived)

  const config = buildSessionStatusConfig(derived, { live, markerEffectCount: markerCount })

  const [redirectHintVisible, setRedirectHintVisible] = useState(false)
  const redirectHintTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (redirectHintTimer.current !== null) window.clearTimeout(redirectHintTimer.current)
    },
    []
  )

  if (!sessionId) return null

  const handleRedirect = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (onRedirect) {
      onRedirect()
    } else {
      const editor = findVisibleZoneEditor(e.currentTarget.closest<HTMLElement>("[data-editor-zone]"))
      if (!editor) return
      focusAtEnd(editor)
    }

    if (redirectHintTimer.current !== null) window.clearTimeout(redirectHintTimer.current)
    setRedirectHintVisible(true)
    redirectHintTimer.current = window.setTimeout(() => setRedirectHintVisible(false), REDIRECT_HINT_MS)
  }

  // Stop and Redirect are gated on "session running", not on which tool is
  // active — the backend aborts the whole session gracefully regardless
  // (roadmap 2.1), so the buttons stay stable for the entire run (INV-21).
  const showSessionActions = status === "running"
  // `retrying` counts: it means started + interrupted with no terminal event, so
  // an attempt is running right now. Its earlier attempts' writes ride the
  // `interrupted` payloads (a retry's `upsertStep` resets the step's effects),
  // and go in as `priorEffects` so the grid keeps them while the new attempt
  // streams onto the end. Same reason the live substep shows while retrying.
  const inFlight = status === "running" || status === "retrying"
  const showRedirectHint = showSessionActions && redirectHintVisible
  // Substep also shows while retrying — a resumed attempt streams its live phase
  // text, which is what keeps the amber "Interrupted, retrying…" card from reading
  // as a hang during a long retry.
  const showLiveSubstep = (status === "running" || status === "retrying") && !!liveSubstep
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
            {/* Truncate rather than wrap: on narrow viewports the running
                card's two right-slot buttons squeeze this column, and a
                two-line title would grow the card height (INV-21). */}
            <div
              className="min-w-0 truncate font-medium"
              style={config.titleColor ? { color: config.titleColor } : undefined}
            >
              {config.title}
            </div>
            {sessionVersion != null && sessionVersion > 1 && (
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
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
            <div className="mt-0.5 min-w-0 truncate text-[11px] text-muted-foreground">
              {config.subtitle || "\u00a0"}
            </div>
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
      {/* Sibling of the card link, never a child: the card is an <a>. */}
      {inFlight ? (
        <LiveSessionEffectGrid
          key={sessionId}
          workspaceId={workspaceId}
          sessionId={sessionId}
          priorEffects={describedEffects}
        />
      ) : (
        <SessionEffectGrid effects={describedEffects} />
      )}
    </div>
  )
}
