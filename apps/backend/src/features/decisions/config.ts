/** Decision-request timing. One source of truth (INV-33). */

/**
 * Expiry-sweep cadence. A decision carries its own `expiresAt`, so the sweep
 * only has to notice one passing — 30 s keeps the card's "expired" state close
 * enough to the deadline that a waiting runtime is not left guessing.
 */
export const DECISION_EXPIRY_SWEEP_INTERVAL_MS = 30_000

/** The furthest out a requester may push its own deadline. */
export const DECISION_MAX_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

export const DECISION_TITLE_MAX_CHARS = 200
export const DECISION_BODY_MAX_CHARS = 8000
export const DECISION_OPTIONS_MAX = 8
export const DECISION_OPTION_ID_MAX_CHARS = 64
export const DECISION_OPTION_LABEL_MAX_CHARS = 80
export const DECISION_EXTERNAL_REF_MAX_CHARS = 256
export const DECISION_NOTE_MAX_CHARS = 2000
