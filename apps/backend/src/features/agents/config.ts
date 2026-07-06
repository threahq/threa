/**
 * Persona agent supersede rerun response validation config (INV-44).
 * Shared between production code and any future evals.
 */
export const SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID = "openrouter:anthropic/claude-haiku-4.5"
export const SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS = 180
export const SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE = 0

/**
 * Turn digest (C-1) findings model for companion turns (INV-44). One cheap
 * post-turn call condensing the loop's tool work; generation bounds live with
 * the shared component (`@threa/agent-runtime` turn-digest). The enclave uses
 * its own pinned turn model instead — it has exactly one egress-approved model.
 */
export const TURN_DIGEST_MODEL_ID = "openrouter:anthropic/claude-haiku-4.5"

/**
 * Follow-up scheduling bounds (`schedule_follow_up` tool, roadmap 1.1).
 *
 * `DEFAULT_MAX_PENDING_FOLLOW_UPS` is the code default cap on pending follow-ups
 * per stream, re-exported from `@threa/types` where `DEFAULT_WORKSPACE_SETTINGS`
 * seeds the workspace-tunable setting from the same number (INV-33). The
 * follow-up service's `resolveFollowUpLimit()` resolves the workspace override
 * against this default (roadmap 1.4).
 *
 * `MAX_FOLLOW_UP_HORIZON_DAYS` bounds how far out a follow-up may be scheduled —
 * these are minutes-to-days "check back later" nudges, not long-horizon jobs
 * (the anti-goal behind proposed INV-64).
 */
export { DEFAULT_MAX_PENDING_FOLLOW_UPS } from "@threa/types"
export const MAX_FOLLOW_UP_HORIZON_DAYS = 30
