/** Per-socket budget for relayed `doc:awareness` frames; a client sends at most one per 50 ms window plus 15 s renewals. */
export const DOC_AWARENESS_RATE_BURST = 40
export const DOC_AWARENESS_RATE_REFILL_PER_SEC = 25

/** A doc's edits roll up into one host `doc:activity` row once it has been quiet this long. */
export const DOC_ACTIVITY_QUIET_MS = 30_000
