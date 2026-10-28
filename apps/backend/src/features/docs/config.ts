/** Per-socket budget for relayed `doc:awareness` frames; a client sends at most one per 50 ms window plus 15 s renewals. */
export const DOC_AWARENESS_RATE_BURST = 40
export const DOC_AWARENESS_RATE_REFILL_PER_SEC = 25
