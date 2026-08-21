/**
 * Canonical slot contract — the hydration envelope carried alongside any
 * response that renders message content. A "slot" is a keyed hydration value
 * a renderable pointer node overlays at render time, so clients never read
 * another stream's message directly.
 *
 * Keys are namespaced (`shared:<messageId>`) so distinct slot types own
 * distinct key spaces. Today the only inhabitant is the shared-message slot;
 * a future slot type adds a union member and its own namespace without
 * reinterpreting these keys. Wire shape only — strings/dates, never `Date`.
 */
import type { StreamType, Visibility } from "./constants"
import type { AttachmentSummary } from "./domain"
import type { ContentRange } from "./prosemirror"

/**
 * Wire-format variants for a shared-message pointer's hydrated content.
 *
 * - `ok`: viewer has access; current source content is inlined.
 * - `deleted`: source row exists but is tombstoned.
 * - `missing`: source row never existed (or was hard-deleted in a way that
 *   leaves no tombstone — defended for, shouldn't normally occur).
 * - `private`: viewer has no read access to the source and no share-grant
 *   reaches them. Reveals only the source stream's `kind` + `visibility`,
 *   never the content/author/stream-name.
 * - `truncated`: hydration stopped at the recursion depth cap for an
 *   accessible chain; viewer can follow `streamId` to read in source.
 */
export type SharedMessageSlot =
  | {
      type: "sharedMessage"
      state: "ok"
      messageId: string
      streamId: string
      authorId: string
      authorType: string
      authorName: string | null
      contentJson: unknown
      contentMarkdown: string
      editedAt: string | null
      createdAt: string
      attachments: AttachmentSummary[]
      /** Source revision this content was pinned to. */
      version?: number
      /** The source's revision right now; greater than `version` = edited since. */
      currentRevision?: number
      /** Span of the pinned version rendered here; `null` = the whole message. */
      range?: ContentRange | null
    }
  | { type: "sharedMessage"; state: "deleted"; messageId: string; deletedAt: string }
  | { type: "sharedMessage"; state: "missing"; messageId: string }
  | {
      type: "sharedMessage"
      state: "private"
      messageId: string
      sourceStreamKind: StreamType
      sourceVisibility: Visibility
    }
  | { type: "sharedMessage"; state: "truncated"; messageId: string; streamId: string }

/**
 * One hydration value in the envelope. Discriminated by `type`; the
 * shared-message slot is the sole inhabitant today.
 */
export type Slot = SharedMessageSlot

/** The canonical slot envelope: namespaced key → slot value. */
export type SlotMap = Record<string, Slot>

/**
 * A shared-message pointer reduced to what hydration resolves it against:
 * which message, which revision of it, which span of that revision.
 */
export interface SharedMessageRef {
  messageId: string
  /** `null` = unpinned legacy node; hydrate at the source's current revision. */
  version: number | null
  /** `null` = the whole message. */
  range: ContentRange | null
}

/**
 * Canonical key for a shared-message slot. Namespaced so a future slot type
 * cannot collide with a source message id, and carrying the pin so two
 * pointers at the same message but different revisions or spans get their own
 * hydrated content instead of sharing one.
 *
 * `shared:<id>` · `shared:<id>@<version>` · `shared:<id>@<version>:<from>-<to>`
 */
export function sharedMessageSlotKey(messageId: string, version?: number | null, range?: ContentRange | null): string {
  if (version == null) return `shared:${messageId}`
  if (!range) return `shared:${messageId}@${version}`
  return `shared:${messageId}@${version}:${range.from}-${range.to}`
}

const SHARED_MESSAGE_SLOT_KEY_PATTERN = /^shared:([^@]+)(?:@(\d+)(?::(\d+)-(\d+))?)?$/

/**
 * Inverse of {@link sharedMessageSlotKey}. Returns `null` for anything that
 * isn't a shared-message slot key, so a caller holding a mixed key space can
 * route on the result.
 */
export function parseSharedMessageSlotKey(key: string): SharedMessageRef | null {
  const match = SHARED_MESSAGE_SLOT_KEY_PATTERN.exec(key)
  if (!match) return null
  const [, messageId, version, from, to] = match
  return {
    messageId,
    version: version === undefined ? null : Number(version),
    range: from === undefined || to === undefined ? null : { from: Number(from), to: Number(to) },
  }
}
