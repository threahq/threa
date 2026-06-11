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
