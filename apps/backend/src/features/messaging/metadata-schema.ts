/**
 * Shared Zod schema + constants for message metadata (external references).
 *
 * Metadata is a flat string->string map queried with AND-containment semantics.
 * Keys under the `threa.*` namespace are reserved for system-generated metadata
 * so user callers can't spoof internal markers.
 */
import { z } from "zod"

export const MESSAGE_METADATA_MAX_KEYS = 20
export const MESSAGE_METADATA_MAX_KEY_LENGTH = 64
export const MESSAGE_METADATA_MAX_VALUE_LENGTH = 256
export const MESSAGE_METADATA_MAX_SERIALIZED_BYTES = 4096
export const MESSAGE_METADATA_RESERVED_PREFIX = "threa."

/** Allowed characters for metadata keys: letters, digits, `_.-:` */
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_.\-:]+$/

/**
 * Validator for caller-supplied metadata on message creation.
 * - Rejects reserved `threa.*` keys.
 * - Caps map size (keys), individual key/value length, and total serialized size.
 */
export const messageMetadataSchema = z
  .record(
    z
      .string()
      .min(1, "metadata keys must be non-empty")
      .max(
        MESSAGE_METADATA_MAX_KEY_LENGTH,
        `metadata keys must be at most ${MESSAGE_METADATA_MAX_KEY_LENGTH} characters`
      )
      .regex(METADATA_KEY_PATTERN, "metadata keys may only contain letters, digits, and _.-:"),
    z
      .string()
      .max(
        MESSAGE_METADATA_MAX_VALUE_LENGTH,
        `metadata values must be at most ${MESSAGE_METADATA_MAX_VALUE_LENGTH} characters`
      )
  )
  .refine((m) => !Object.keys(m).some((k) => k.startsWith(MESSAGE_METADATA_RESERVED_PREFIX)), {
    message: `metadata keys starting with "${MESSAGE_METADATA_RESERVED_PREFIX}" are reserved`,
  })
  .refine((m) => Object.keys(m).length <= MESSAGE_METADATA_MAX_KEYS, {
    message: `metadata may contain at most ${MESSAGE_METADATA_MAX_KEYS} keys`,
  })
  .refine((m) => JSON.stringify(m).length <= MESSAGE_METADATA_MAX_SERIALIZED_BYTES, {
    message: `metadata exceeds ${MESSAGE_METADATA_MAX_SERIALIZED_BYTES} serialized bytes`,
  })

/**
 * Validator for a non-empty metadata filter used by the find-by-metadata endpoint.
 * Same shape as {@link messageMetadataSchema} but requires at least one key (an
 * empty filter would match every message with metadata, which is never useful).
 *
 * Reserved keys are allowed here because callers may legitimately query system-
 * generated metadata (e.g. "show me messages `threa.source` set").
 */
export const messageMetadataFilterSchema = z
  .record(
    z
      .string()
      .min(1, "metadata keys must be non-empty")
      .max(MESSAGE_METADATA_MAX_KEY_LENGTH)
      .regex(METADATA_KEY_PATTERN, "metadata keys may only contain letters, digits, and _.-:"),
    z.string().max(MESSAGE_METADATA_MAX_VALUE_LENGTH)
  )
  .refine((m) => Object.keys(m).length > 0, { message: "metadata filter must have at least one key" })
  .refine((m) => Object.keys(m).length <= MESSAGE_METADATA_MAX_KEYS, {
    message: `metadata filter may contain at most ${MESSAGE_METADATA_MAX_KEYS} keys`,
  })

/**
 * Server-derived key naming the agents whose text a message carries (comma
 * separated `persona_`/`bot_` ids, document order). Written from the message's
 * own `agentBlock` nodes at create — never by a caller, since `threa.*` is
 * rejected on input — so attribution stays queryable even after the block is
 * edited or the node is later removed from the stored content.
 */
export const MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY = "threa.agent_block_authors"

/**
 * Fold the derived agent-block marker into caller metadata. Returns `undefined`
 * for an empty result so payloads and projections stay clean of `{}`. Authors
 * that would push the value past the column's value cap are dropped rather than
 * truncated mid-id — a partial id would read as a real, wrong actor.
 */
export function withDerivedMessageMetadata(
  metadata: Record<string, string> | undefined,
  agentBlockAuthorIds: string[]
): Record<string, string> | undefined {
  const kept: string[] = []
  for (const authorId of agentBlockAuthorIds) {
    const next = kept.length === 0 ? authorId : `${kept.join(",")},${authorId}`
    if (next.length > MESSAGE_METADATA_MAX_VALUE_LENGTH) break
    kept.push(authorId)
  }
  const merged = {
    ...(metadata ?? {}),
    ...(kept.length > 0 && { [MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY]: kept.join(",") }),
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
