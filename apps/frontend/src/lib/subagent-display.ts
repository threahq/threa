import {
  SUBAGENT_FAILURE_REASONS,
  SUBAGENT_TERMINAL_STATUSES,
  SubagentStatuses,
  type SubagentCreatedEventPayload,
  type SubagentFailureReason,
  type SubagentStatus,
  type ThreadSummary,
} from "@threa/types"

/**
 * What the subagent card says it is doing. An `active` run splits three ways:
 * `working` — a session is live in the thread, the ONLY state that may animate;
 * `waiting` — the subagent spoke last and the reader owes it an answer;
 * `starting` — active with nothing running, because the kickoff is queued or the
 * reader's reply has not been dispatched yet. Everything terminal maps to its
 * status.
 *
 * `starting` reads as "Working" to the user — the run IS ours, not theirs — but
 * it is a separate state because a spinner with no session behind it is a lie,
 * and every surface without a session signal (board ledger, outcomes list) can
 * only ever resolve to this one.
 */
export type SubagentCardState = "working" | "starting" | "waiting" | "completed" | "failed" | "cancelled" | "expired"

export const SUBAGENT_TERMINAL: ReadonlySet<SubagentStatus> = new Set(SUBAGENT_TERMINAL_STATUSES)

export const SUBAGENT_STATE_LABEL: Record<SubagentCardState, string> = {
  working: "Working",
  starting: "Working",
  waiting: "Waiting for you",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
}

/** Only a live session may animate — see {@link SubagentCardState}. */
export function subagentStateAnimates(state: SubagentCardState): boolean {
  return state === "working"
}

/**
 * Gold is reserved for the one state that owes the reader something (INV-63's
 * rule applied to color): `waiting`. Working stays neutral — the spinner already
 * says busy — and terminal states go quiet.
 */
export function subagentStatePillClass(state: SubagentCardState): string {
  switch (state) {
    case "waiting":
      return "bg-primary/15 text-primary"
    case "completed":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    case "failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400"
    case "working":
    case "starting":
    case "cancelled":
    case "expired":
      return "bg-muted text-muted-foreground"
  }
}

/**
 * `subagent_runs.status_note` on a system transition is a reason CODE, never
 * prose (INV-46/54) — this is the only place it becomes words. An unrecognised
 * note renders nothing rather than leaking a code at the reader.
 */
const SUBAGENT_FAILURE_REASON_LABEL: Record<SubagentFailureReason, string> = {
  turn_failed: "the turn failed",
  session_orphaned: "the session was lost",
  kickoff_failed: "it never started",
}

export function subagentFailureLabel(statusNote: string | null | undefined): string | null {
  if (!statusNote) return null
  const reason = SUBAGENT_FAILURE_REASONS.find((code) => code === statusNote)
  return reason ? SUBAGENT_FAILURE_REASON_LABEL[reason] : null
}

export interface SubagentCardStateInput {
  status: SubagentStatus
  /** A session is live in the subagent's thread (the parent-anchored activity alias). */
  hasLiveSession: boolean
  /** From the latest status patch: when the subagent last posted in its thread. */
  lastAgentMessageAt?: string | null
  /** Healed thread stats on the card's own payload — who actually spoke last. */
  threadSummary?: ThreadSummary
}

/**
 * The card's state, from data the timeline already holds — no fetch.
 *
 * "Waiting" needs one fact: did the subagent speak last. Two sources carry it and
 * neither is complete alone. The status patch's `lastAgentMessageAt` lands the
 * moment a session finishes having posted, but says nothing about a reply that
 * came after; the healed `threadSummary` knows who spoke last but is only
 * refreshed on thread updates, so it can lag a just-finished turn. So: take the
 * newer of the two, and when the thread stats are the newer one, believe who
 * they say spoke.
 *
 * Everything else active is `starting`, never `working`: a caller with no
 * session signal to give must not be handed the animated state.
 */
export function resolveSubagentCardState(input: SubagentCardStateInput): SubagentCardState {
  if (input.status !== SubagentStatuses.ACTIVE) return input.status
  if (input.hasLiveSession) return "working"

  const agentMs = input.lastAgentMessageAt ? Date.parse(input.lastAgentMessageAt) : NaN
  if (Number.isNaN(agentMs)) return "starting"

  const replyMs = input.threadSummary ? Date.parse(input.threadSummary.lastReplyAt) : NaN
  if (Number.isNaN(replyMs) || agentMs >= replyMs) return "waiting"
  return input.threadSummary!.latestReply.actorType === "user" ? "starting" : "waiting"
}

/**
 * The run a thread IS, resolved from its anchor card in the parent stream.
 * `endedAt` is set only once the run reached a terminal status, so an open run's
 * window has no upper bound.
 */
export interface SubagentThreadRun {
  subagentId: string
  model: string
  personaId: string
  startedAt: string
  endedAt: string | null
}

/**
 * The badge window for the thread a subagent card anchors.
 *
 * Two traps live here. The run's state is the LAST patch, never the last
 * TERMINAL one: a requeue appends an `active` patch after a terminal one, and
 * closing the window on the terminal row would unbadge every message of the
 * restarted run, permanently. And a thread opened by deep link has no patches in
 * reach at all — without the authoritative row behind it a finished run reads as
 * open and badges everything posted after it closed.
 */
export function resolveSubagentThreadRun(input: {
  card: { createdAt: string; payload: SubagentCreatedEventPayload }
  /** This run's status transitions, oldest → newest. */
  orderedPatches: ReadonlyArray<{ at: string; status: SubagentStatus }>
  /** The run row, for when `orderedPatches` cannot contain the transition. */
  fallback?: { status: SubagentStatus; statusChangedAt: string } | null
}): SubagentThreadRun {
  const latest = input.orderedPatches[input.orderedPatches.length - 1]
  const status = latest?.status ?? input.fallback?.status
  const settledAt = latest?.at ?? input.fallback?.statusChangedAt ?? null
  return {
    subagentId: input.card.payload.subagentId,
    model: input.card.payload.model,
    personaId: input.card.payload.personaId,
    startedAt: input.card.createdAt,
    endedAt: status && SUBAGENT_TERMINAL.has(status) ? settledAt : null,
  }
}

/**
 * Whether a message was authored by the delegated model. The persona is the same
 * one either way (v1 identity), so the window is the only thing separating
 * "Ariadne running as Opus 5" from plain Ariadne — a reply after the run closed
 * is an ordinary turn on the persona's own model and must not carry the badge.
 */
export function isSubagentAuthoredMessage(
  run: SubagentThreadRun,
  message: { actorId: string | null; actorType: string | null; createdAt: string }
): boolean {
  if (message.actorType !== "persona" || message.actorId !== run.personaId) return false
  const at = Date.parse(message.createdAt)
  if (Number.isNaN(at)) return false
  if (at < Date.parse(run.startedAt)) return false
  return run.endedAt === null || at <= Date.parse(run.endedAt)
}
