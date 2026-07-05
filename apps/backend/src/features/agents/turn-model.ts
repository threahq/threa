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
}

export interface TurnModelContext {
  /** The turn's EFFECTIVE purpose (a degraded supersede rerun never escalates). */
  purpose: TurnPurpose
  /**
   * The session this rerun supersedes, when the purpose is `supersede_rerun`
   * and the session was loaded. Null/absent for every other purpose.
   */
  supersededSession: { responseValidationFailed: boolean } | null
}

/**
 * Resolve the model for one persona turn.
 *
 * Rule v1 — the only escalation rule (mechanical, no language heuristics per
 * INV-54): a supersede rerun whose previous attempt kept its response because
 * drafts repeatedly failed the response validator runs on the persona's
 * `escalationModel`. Everything else runs `persona.model`. An escalation to
 * the same id reports `escalated: false` so the trace never shows a no-op
 * escalation step.
 */
export function resolveTurnModel(
  persona: { model: string; escalationModel: string | null },
  turnContext: TurnModelContext
): ResolvedTurnModel {
  const { purpose, supersededSession } = turnContext
  if (
    purpose.kind === "supersede_rerun" &&
    supersededSession?.responseValidationFailed &&
    persona.escalationModel !== null &&
    persona.escalationModel !== persona.model
  ) {
    return { model: persona.escalationModel, escalated: true }
  }
  return { model: persona.model, escalated: false }
}
