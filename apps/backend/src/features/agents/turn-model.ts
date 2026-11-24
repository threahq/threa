import type { TurnPurpose } from "./turn-purpose"

/**
 * The model a turn actually runs on, resolved once at the dispatch seam
 * (alongside `resolveContextWindowPolicy`) and handed to the turn request —
 * never chosen inside the loop. Breaks the static `persona.model` assumption
 * (roadmap 2.3): the persona's model is the default, and per-turn escalation
 * rules may pick the persona's `escalationModel` instead.
 */
export type ResolvedTurnModel =
  | { model: string; escalated: false }
  | {
      model: string
      /** An escalation rule fired (renders as a `model_escalated` trace step). */
      escalated: true
      /** The model the turn would have run had the firing rule not applied. */
      fromModel: string
      /** Which rule fired, for the trace step's label. */
      cause: TurnModelEscalationCause
    }

/**
 * Why this turn left `persona.model`. `previous_attempt_failed_validation` is
 * the supersede-rerun rule; `subagent` means the turn is running inside a
 * subagent thread and is bound to that run's delegated model.
 */
export type TurnModelEscalationCause =
  | "previous_attempt_failed_validation"
  | "subagent"
  | "residency_pinned"
  | "model_unavailable"
  | "provider_failed"

const PRIMARY_FALLBACK_MODEL = "openrouter:anthropic/claude-haiku-5.5"
const SECONDARY_FALLBACK_MODEL = "openrouter:openai/gpt-6-luna"

/** The model a turn falls back to when `model` cannot run for it. */
export function fallbackModelFor(model: string): string {
  return model === PRIMARY_FALLBACK_MODEL ? SECONDARY_FALLBACK_MODEL : PRIMARY_FALLBACK_MODEL
}

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
  /** Whether the workspace keeps AI on regionally-runnable models. */
  residencyPinned: boolean
  isSingleRegion: (model: string) => boolean
  /** Whether this deployment has the model's provider configured. */
  canRunModel: (model: string) => boolean
  /** The model this session's previous attempt failed on with a provider error, if it did. */
  providerFailedModel?: string | null
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
 * Everything else runs `persona.model`. Whatever those rules chose, a pinned
 * workspace never runs a single-region model, and no workspace runs a model
 * whose provider this deployment lacks: a blocked rule choice gives way to
 * `persona.model`, and a blocked `persona.model` to `fallbackModelFor` it.
 * A provider failure on the resulting model in the session's previous attempt
 * swaps in `fallbackModelFor` it for this attempt. A binding that lands on
 * `persona.model` reports `escalated: false`, so the trace never shows a no-op
 * escalation step.
 */
export function resolveTurnModel(
  persona: { model: string; escalationModel: string | null },
  turnContext: TurnModelContext
): ResolvedTurnModel {
  const chosen = resolveRuleModel(persona, turnContext)
  const blocked = modelBlockCause(chosen.model, turnContext)
  const placed = blocked
    ? switchedFrom(chosen.model, unblockedModelFor(chosen.model, persona, turnContext), blocked)
    : chosen
  return turnContext.providerFailedModel === placed.model
    ? switchedFrom(placed.model, fallbackModelFor(placed.model), "provider_failed")
    : placed
}

/** Why `model` may not run for this workspace on this deployment, or null when it may. */
export function modelBlockCause(
  model: string,
  placement: Pick<TurnModelContext, "residencyPinned" | "isSingleRegion" | "canRunModel">
): "residency_pinned" | "model_unavailable" | null {
  if (placement.residencyPinned && placement.isSingleRegion(model)) return "residency_pinned"
  if (!placement.canRunModel(model)) return "model_unavailable"
  return null
}

function unblockedModelFor(model: string, persona: { model: string }, turnContext: TurnModelContext): string {
  return model !== persona.model && !modelBlockCause(persona.model, turnContext)
    ? persona.model
    : fallbackModelFor(model)
}

function switchedFrom(fromModel: string, model: string, cause: TurnModelEscalationCause): ResolvedTurnModel {
  return { model, escalated: true, fromModel, cause }
}

function resolveRuleModel(
  persona: { model: string; escalationModel: string | null },
  turnContext: TurnModelContext
): ResolvedTurnModel {
  const { purpose, supersededSession, activeSubagentModel } = turnContext
  if (activeSubagentModel) {
    return activeSubagentModel === persona.model
      ? { model: persona.model, escalated: false }
      : { model: activeSubagentModel, escalated: true, fromModel: persona.model, cause: "subagent" }
  }
  if (
    purpose.kind === "supersede_rerun" &&
    supersededSession?.responseValidationFailed &&
    persona.escalationModel !== null &&
    persona.escalationModel !== persona.model
  ) {
    return {
      model: persona.escalationModel,
      escalated: true,
      fromModel: persona.model,
      cause: "previous_attempt_failed_validation",
    }
  }
  return { model: persona.model, escalated: false }
}
