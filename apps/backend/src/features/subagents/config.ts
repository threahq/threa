/**
 * How long an `active` subagent run may sit with no status movement before the
 * sweep expires it. A subagent whose user never answers must not hold the
 * stream's one live slot forever.
 */
export const SUBAGENT_IDLE_EXPIRY_DAYS = 7

/** How often the expiry sweep runs (hourly — the threshold is days). */
export const SUBAGENT_EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Max runs expired per sweep pass. Each expiry appends a card status event in
 * the sweep's transaction, so the cap bounds that transaction; the hourly sweep
 * drains any backlog across passes.
 */
export const SUBAGENT_EXPIRY_SWEEP_LIMIT = 200

export { SUBAGENT_TITLE_MAX_CHARS, SUBAGENT_BRIEF_MAX_CHARS } from "@threahq/types"
