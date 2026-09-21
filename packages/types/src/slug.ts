/**
 * Shared slug validation rules.
 *
 * Slugs are URL-safe identifiers used for users, personas, channels, and workspaces.
 * These rules are the single source of truth for both frontend and backend.
 *
 * Valid slug characteristics:
 * - Lowercase letters (a-z) and numbers (0-9) only
 * - Hyphens (-) and underscores (_) allowed as separators (consecutive allowed)
 * - Must start with a letter
 * - No leading/trailing separators
 * - Max 50 characters
 */

export const SLUG_MAX_LENGTH = 50

/**
 * Pattern for a valid slug.
 * - Starts with a letter
 * - Followed by alphanumeric characters, hyphens, or underscores
 * - Ends with alphanumeric (no trailing separator)
 */
export const SLUG_PATTERN = /^[a-z](?:[a-z0-9_-]*[a-z0-9])?$/

const SLUG_TOKEN = "[a-z](?:[a-z0-9_-]*[a-z0-9])?"

/**
 * A bare `@slug`/`#slug` counts only as a whole token: whitespace, `(` or the
 * start of the text before it; whitespace, `)` or the end after it, optionally
 * behind sentence punctuation. Anything else touching it (`@org/pkg`,
 * `` `@x` ``, `a@b.io`, `#tag.md`) means the text names something longer.
 * Lookarounds only, so the patterns splice into larger regexes without
 * shifting their groups.
 */
export const TRIGGER_TOKEN_START = "(?<=^|[\\s(])"
export const TRIGGER_TOKEN_END = "(?=$|[\\s)]|[.,!?;:]+(?:$|[\\s)]))"

/** `@slug` as a whole token; group 1 is the slug. */
export const MENTION_PATTERN = new RegExp(`${TRIGGER_TOKEN_START}@(${SLUG_TOKEN})${TRIGGER_TOKEN_END}`, "g")

/** `#slug` as a whole token; group 1 is the slug. */
export const CHANNEL_PATTERN = new RegExp(`${TRIGGER_TOKEN_START}#(${SLUG_TOKEN})${TRIGGER_TOKEN_END}`, "g")

/**
 * Check if a string is a valid slug.
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > SLUG_MAX_LENGTH) {
    return false
  }

  return SLUG_PATTERN.test(slug)
}

/**
 * Characters that are NOT allowed in slugs.
 * Used for generating clear error messages.
 */
export const INVALID_SLUG_CHARS = /[^a-z0-9_-]/g

/**
 * Reserved slugs for broadcast mentions (@channel, @here).
 * Single source of truth used by both frontend filtering and backend resolution.
 */
export const BROADCAST_SLUGS = ["channel", "here"] as const
export type BroadcastSlug = (typeof BROADCAST_SLUGS)[number]

export function isBroadcastSlug(slug: string): slug is BroadcastSlug {
  return BROADCAST_SLUGS.includes(slug as BroadcastSlug)
}
