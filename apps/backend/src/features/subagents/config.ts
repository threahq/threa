/**
 * How long an `active` subagent run may sit with no status movement before the
 * sweep expires it. A subagent whose user never answers must not hold the
 * stream's one live slot forever.
 */
export const SUBAGENT_IDLE_EXPIRY_DAYS = 7

/** How often the expiry sweep runs (hourly — the threshold is days). */
export const SUBAGENT_EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export { SUBAGENT_TITLE_MAX_CHARS, SUBAGENT_BRIEF_MAX_CHARS } from "@threa/types"
