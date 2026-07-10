/**
 * Delegation limits and claim timing (roadmap 5.1). One source of truth
 * (INV-33/44). The content caps live in `@threa/types` — the `delegate_task`
 * tool (features/agents/) needs them too, and importing this feature's barrel
 * from an agents tool would close a module cycle through the agents barrel —
 * and are re-exported here so feature code has one import site.
 */
export { DELEGATION_TITLE_MAX_CHARS, DELEGATION_BRIEF_MAX_CHARS, DELEGATION_CONTEXT_REFS_MAX } from "@threa/types"

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
