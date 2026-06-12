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

/**
 * Pattern for extracting @mentions from text.
 * Matches @slug where slug follows the valid slug pattern.
 *
 * Key constraints:
 * - @ must NOT be preceded by alphanumeric (avoids email addresses)
 * - Slug must be valid (a-z, 0-9, hyphens, underscores, starts with letter)
 * - Slug must NOT be followed by chars that suggest user intended a longer slug
 */
export const MENTION_PATTERN = /(?<![a-z0-9])@([a-z][a-z0-9_-]*[a-z0-9]|[a-z])(?![a-z0-9.-])/g

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
