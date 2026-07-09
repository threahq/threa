/**
 * Delegation limits and claim timing (roadmap 5.1). Shared by the service, the
 * tool's input schema, and (later) evals — one source of truth (INV-33/44).
 */

/** Card title — short enough to scan in the timeline. */
export const DELEGATION_TITLE_MAX_CHARS = 200

/**
 * The compiled hand-off prompt. Generous — a self-contained brief with
 * acceptance criteria is the whole point — but bounded so a runaway turn can't
 * persist megabytes onto the timeline event.
 */
export const DELEGATION_BRIEF_MAX_CHARS = 20_000

/** Pointer URLs per delegation; enough to link the relevant sources without inlining walls of text. */
export const DELEGATION_CONTEXT_REFS_MAX = 20

/**
 * How long a claim holds without a heartbeat before the expiry sweep flips the
 * delegation to `expired`. Local agents heartbeat well inside this (the 5.3
 * endpoints renew on every progress report); 15 minutes tolerates a laptop
 * napping through a poll cycle without letting a dead claim wedge the task for
 * long.
 */
export const DELEGATION_CLAIM_TTL_SECONDS = 15 * 60

/** Expiry-sweep cadence. Lapsed claims are reaped within a minute of the TTL passing. */
export const DELEGATION_EXPIRY_SWEEP_INTERVAL_MS = 60_000
