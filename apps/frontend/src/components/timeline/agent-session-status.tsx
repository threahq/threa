import { Check, X, Loader2 } from "lucide-react"
import type {
  ActiveAgentSession,
  StreamEvent,
  AgentSessionRerunContext,
  AgentSessionStartedPayload,
  AgentSessionCompletedPayload,
  AgentSessionFailedPayload,
  AgentSessionInterruptedPayload,
  AgentSessionDeletedPayload,
  AgentToolEffect,
} from "@threahq/types"
import { formatDuration } from "@/lib/dates"
import { isDescribedEffect, unionSessionEffects } from "@/lib/effect-links"
import { SPEND_DENIAL_COPY } from "@/lib/ai-spend-denial"

export type SessionStatus = "running" | "retrying" | "completed" | "failed" | "deleted"

export interface StatusConfig {
  title: string
  subtitle: string
  icon: React.ReactNode
  borderColor: string
  bgColor: string
  hoverBgColor: string
  titleColor?: string
  timestamp: string | null
}

export function deriveSessionStatus(events: StreamEvent[]): {
  status: SessionStatus
  sessionId: string
  startedPayload: AgentSessionStartedPayload | null
  completedPayload: AgentSessionCompletedPayload | null
  failedPayload: AgentSessionFailedPayload | null
  interruptedPayload: AgentSessionInterruptedPayload | null
  /**
   * EVERY interrupted payload, oldest first. The status line only needs the
   * latest, but a retry resets its step rows' effects, so each attempt's
   * interrupted event is the only surviving record of what THAT attempt wrote.
   * Keeping just the last one loses every write before the final retry.
   */
  interruptedPayloads: AgentSessionInterruptedPayload[]
  deletedPayload: AgentSessionDeletedPayload | null
} {
  let startedPayload: AgentSessionStartedPayload | null = null
  let completedPayload: AgentSessionCompletedPayload | null = null
  let failedPayload: AgentSessionFailedPayload | null = null
  let interruptedPayload: AgentSessionInterruptedPayload | null = null
  const interruptedPayloads: AgentSessionInterruptedPayload[] = []
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
      case "agent_session:interrupted":
        // Last one wins — a later attempt's interrupt supersedes the prior.
        interruptedPayload = event.payload as AgentSessionInterruptedPayload
        interruptedPayloads.push(interruptedPayload)
        break
      case "agent_session:deleted":
        deletedPayload = event.payload as AgentSessionDeletedPayload
        break
    }
  }

  // Precedence, terminal first: deleted (superseding) › completed › failed. A
  // terminal event always wins over `interrupted`, which is non-terminal — a
  // retryable attempt emits it, then the retry's own completed/failed supersedes
  // it. With only started + interrupted present (mid-retry, incl. after a refresh)
  // the session reads as "retrying"; a bare started with none of these is "running".
  let status: SessionStatus
  if (deletedPayload) {
    status = "deleted"
  } else if (completedPayload) {
    status = "completed"
  } else if (failedPayload) {
    status = "failed"
  } else if (interruptedPayload) {
    status = "retrying"
  } else {
    status = "running"
  }

  return {
    status,
    sessionId,
    startedPayload,
    completedPayload,
    failedPayload,
    interruptedPayload,
    interruptedPayloads,
    deletedPayload,
  }
}

export type DerivedSession = ReturnType<typeof deriveSessionStatus>

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

/** What a settled session reports about itself; a failed run's duration is its start-to-failure span. */
export function sessionTotals({ startedPayload, completedPayload, failedPayload }: DerivedSession): {
  steps: number
  durationMs: number | null
  messages: number
} {
  if (completedPayload) {
    return {
      steps: completedPayload.stepCount,
      durationMs: completedPayload.duration,
      messages: completedPayload.messageCount,
    }
  }
  if (failedPayload) {
    const durationMs = startedPayload ? Date.parse(failedPayload.failedAt) - Date.parse(startedPayload.startedAt) : null
    return { steps: failedPayload.stepCount, durationMs, messages: 0 }
  }
  return { steps: 0, durationMs: null, messages: 0 }
}

export function buildSessionStatusConfig(
  derived: DerivedSession,
  {
    live,
    markerEffectCount,
  }: {
    live?: ActiveAgentSession
    /**
     * Layer-0 markers: a mutating tool declared nothing, so the effect is a bare
     * `{ kind }` with nothing to name, diff or link. They ride the meta line as a
     * count rather than the grid, and the meta line is a single truncating line,
     * so this costs no height (INV-21).
     */
    markerEffectCount: number
  }
): StatusConfig {
  const { status, startedPayload, completedPayload, failedPayload, interruptedPayload, deletedPayload } = derived
  const totals = sessionTotals(derived)
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
        parts.push(formatCount(totals.steps, "step"))
        if (totals.durationMs !== null) parts.push(formatDuration(totals.durationMs))
        parts.push(`${formatCount(totals.messages, "message")} sent`)
      }
      const completedChanges = formatMarkerEffectCount(markerEffectCount)
      if (completedChanges) {
        parts.push(completedChanges)
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
        parts.push(formatCount(totals.steps, "step"))
        if (totals.durationMs !== null) parts.push(formatDuration(totals.durationMs))
      }
      const spendDenial = failedPayload?.spendDenial
      parts.push(spendDenial ? SPEND_DENIAL_COPY[spendDenial] : "Error during execution")
      const failedChanges = formatMarkerEffectCount(markerEffectCount)
      if (failedChanges) {
        parts.push(failedChanges)
      }
      return {
        title: spendDenial ? "Session stopped" : "Session failed",
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
    case "retrying": {
      // Non-terminal: a turn attempt failed and the queue is retrying the same
      // session. Amber (not the red terminal-fail) and a spinner, so it reads as
      // "in progress, hang on" rather than "done, broken". A retry restarts its
      // step counter from 1 (SessionTrace is fresh per attempt), so once it's
      // actively progressing (live > 0) we follow the live count — it moves every
      // step and never reads as a hang, even for a retry that re-walks many steps.
      // During backoff the live rail reports 0 (the synthetic started-event entry),
      // so we fall back to the interrupted payload's snapshot (steps reached before
      // the failure) rather than showing 0.
      const liveSteps = live?.stepCount ?? 0
      const steps = liveSteps > 0 ? liveSteps : (interruptedPayload?.stepCount ?? 0)
      const parts: string[] = []
      if (rerunReasonLabel) {
        parts.push(rerunReasonLabel)
      }
      if (rerunReasonDetail) {
        parts.push(rerunReasonDetail)
      }
      parts.push(formatCount(steps, "step"))
      const retryingChanges = formatMarkerEffectCount(markerEffectCount)
      if (retryingChanges) {
        parts.push(retryingChanges)
      }
      return {
        title: "Interrupted, retrying…",
        subtitle: parts.join(" • "),
        icon: (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[hsl(38_92%_50%/0.15)]">
            <Loader2 className="w-3.5 h-3.5 text-[hsl(38,92%,50%)] animate-spin" />
          </div>
        ),
        borderColor: "hsl(38 92% 50% / 0.3)",
        bgColor: "hsl(38 92% 50% / 0.05)",
        hoverBgColor: "hsl(38 92% 50% / 0.08)",
        titleColor: "hsl(38 92% 50%)",
        timestamp: interruptedPayload?.interruptedAt ?? startedPayload?.startedAt ?? null,
      }
    }
    case "running": {
      const personaName = startedPayload?.personaName ?? "Agent"
      const stepCount = live?.stepCount ?? 0
      const messageCount = live?.messageCount ?? 0
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
      parts.push(formatCount(stepCount, "step"))
      parts.push(`${formatCount(messageCount, "message")} sent`)
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

function formatMarkerEffectCount(count: number): string | null {
  if (count <= 0) return null
  return formatCount(count, "change")
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

export function isLiveSessionStatus(status: SessionStatus): boolean {
  return status === "running" || status === "retrying"
}

/**
 * Lifecycle payloads are the authority once a session settles or retries: they
 * survive a reload and carry each retry attempt's writes, which the step rows
 * lose (`upsertStep`'s ON CONFLICT resets `effects`). Grid membership is decided
 * by shape: a bare `{ kind }` marker only earns a count, anything with a target
 * or diff is a row.
 */
export function sessionEffectsFor(derived: DerivedSession): {
  described: AgentToolEffect[]
  markerCount: number
} {
  const { status, interruptedPayloads, completedPayload, failedPayload } = derived
  const all: AgentToolEffect[] =
    status === "completed" || status === "failed" || status === "retrying"
      ? unionSessionEffects(...interruptedPayloads, completedPayload, failedPayload)
      : []
  const described = all.filter(isDescribedEffect)
  return { described, markerCount: all.length - described.length }
}
