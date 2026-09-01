import type { TurnPurpose } from "./turn-purpose"

/**
 * The model a turn actually runs on, resolved once at the dispatch seam
 * (alongside `resolveContextWindowPolicy`) and handed to the turn request —
 * never chosen inside the loop. Breaks the static `persona.model` assumption
 * (roadmap 2.3): the persona's model is the default, and per-turn escalation
 * rules may pick the persona's `escalationModel` instead.
 */
export interface ResolvedTurnModel {
  model: string
  /** True when an escalation rule fired (renders as a `model_escalated` trace step). */
  escalated: boolean
  /** Which rule fired, for the trace step's label. Absent when nothing escalated. */
  cause?: TurnModelEscalationCause
}

/**
 * Why this turn left `persona.model`. `previous_attempt_failed_validation` is
 * the supersede-rerun rule; `subagent` means the turn is running inside a
 * subagent thread and is bound to that run's delegated model.
 */
export type TurnModelEscalationCause = "previous_attempt_failed_validation" | "subagent"

export interface TurnModelContext {
  /** The turn's EFFECTIVE purpose (a degraded supersede rerun never escalates). */
  purpose: TurnPurpose
  /**
   * The session this rerun supersedes, when the purpose is `supersede_rerun`
   * and the session was loaded. Null/absent for every other purpose.
   */
  supersededSession: { responseValidationFailed: boolean } | null
  /**
   * The delegated model of the live subagent run this turn's stream is the
   * thread of, when there is one. Null/absent for every ordinary turn.
   */
  activeSubagentModel?: string | null
}

/**
 * Resolve the model for one persona turn.
 *
 * Two rules, both mechanical — no language heuristics (INV-54):
 * 1. A turn inside a live subagent thread runs that run's delegated model.
 *    This wins outright: the whole point of the run is that this thread is
 *    another model's, and it holds for every turn in the thread (the kickoff
 *    and every later reply alike) until the run settles.
 * 2. A supersede rerun whose previous attempt kept its response because drafts
 *    repeatedly failed the response validator runs on the persona's
 *    `escalationModel`.
 *
 * Everything else runs `persona.model`. A binding that lands on `persona.model`
 * reports `escalated: false`, so the trace never shows a no-op escalation step.
 */
export function resolveTurnModel(
  persona: { model: string; escalationModel: string | null },
  turnContext: TurnModelContext
): ResolvedTurnModel {
  const { purpose, supersededSession, activeSubagentModel } = turnContext
  if (activeSubagentModel) {
    return activeSubagentModel === persona.model
      ? { model: persona.model, escalated: false }
      : { model: activeSubagentModel, escalated: true, cause: "subagent" }
  }
  if (
    purpose.kind === "supersede_rerun" &&
    supersededSession?.responseValidationFailed &&
    persona.escalationModel !== null &&
    persona.escalationModel !== persona.model
  ) {
    return { model: persona.escalationModel, escalated: true, cause: "previous_attempt_failed_validation" }
  }
  return { model: persona.model, escalated: false }
}
