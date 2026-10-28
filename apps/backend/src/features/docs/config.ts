/** Per-socket budget for relayed `doc:awareness` frames; a client sends at most one per 50 ms window plus 15 s renewals. */
export const DOC_AWARENESS_RATE_BURST = 40
export const DOC_AWARENESS_RATE_REFILL_PER_SEC = 25

/** A doc's edits roll up into one host `doc:activity` row once it has been quiet this long. */
export const DOC_ACTIVITY_QUIET_MS = 30_000

/** One line on what an agent changed, shown on the host's timeline. */
export const DOC_REASON_MAX_CHARS = 280

/** Markdown accepted per public-API doc write (a body, or an edit's old/new text). */
export const DOC_PUBLIC_MARKDOWN_MAX_CHARS = 100_000

/** Distinct agent reasons one `doc:activity` row carries; the most recent are kept. */
export const DOC_ACTIVITY_MAX_REASONS = 5

/** A block an author edited settles, and its mentions notify, once that author has left it alone this long. */
export const DOC_MENTION_QUIET_MS = 10_000
