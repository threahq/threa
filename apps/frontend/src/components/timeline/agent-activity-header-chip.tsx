import { Link } from "react-router-dom"
import { Loader2 } from "lucide-react"
import type { ActiveAgentSession } from "@threahq/types"
import { cn } from "@/lib/utils"
import { useTrace } from "@/contexts"
import { useAgentActivityForStream, useAgentSessionActivities } from "@/stores/agent-activity-store"

/**
 * Top-bar chip for the sessions running in exactly `streamId` — the stream this
 * header is the top bar of, so a thread's session lights the thread panel's
 * header rather than its parent's. Renders nothing when idle.
 *
 * `compact` (mobile) drops to a spinner-only pill so the name button keeps its
 * width; it still links to the trace.
 *
 * Two subscriptions rather than one: the stream index compares identity only, so
 * it does not re-render on a step tick, and `useAgentSessionActivities` carries
 * the live counts.
 */
export function AgentActivityHeaderChip({
  workspaceId,
  streamId,
  compact = false,
}: {
  workspaceId: string | undefined
  streamId: string | undefined
  compact?: boolean
}) {
  const sessions = useAgentActivityForStream(workspaceId, streamId)
  const entries = useAgentSessionActivities(
    workspaceId,
    sessions.map((session) => session.sessionId)
  )
  return <AgentRunningChip entries={entries} compact={compact} />
}

/**
 * Presentational core of the chip, over a caller-supplied set of running
 * sessions. The board card scopes its own set by session id (its conversation's
 * rows) rather than by stream, so a sibling conversation's agent can't light it;
 * a stream header scopes by its own stream id. Same copy either way — do not
 * fork it.
 */
export function AgentRunningChip({
  entries,
  compact = false,
}: {
  entries: readonly ActiveAgentSession[]
  compact?: boolean
}) {
  const summary = entries
  const { getTraceUrl } = useTrace()

  if (summary.length === 0) return null

  // "Most recent" click target — the summary is ordered most recently started first.
  const target = summary[0]
  const stepCount = target.stepCount ?? 0
  const single = summary.length === 1
  const label = single ? target.personaName : `${summary.length} agents working`
  const ariaLabel = single
    ? `${target.personaName} is working — open agent trace`
    : `${summary.length} agents working — open agent trace`

  if (compact) {
    return (
      <Link
        to={getTraceUrl(target.sessionId)}
        aria-label={ariaLabel}
        className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      </Link>
    )
  }

  return (
    <Link
      to={getTraceUrl(target.sessionId)}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs font-semibold text-foreground transition-colors",
        "hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
    >
      <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {single && stepCount > 0 && (
        <span className="text-muted-foreground tabular-nums">
          · {stepCount} step{stepCount === 1 ? "" : "s"}
        </span>
      )}
    </Link>
  )
}
