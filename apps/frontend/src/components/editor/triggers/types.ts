import type { CommandArgumentInfo, CommandKind, CommandScope } from "@threa/types"

export interface Mentionable {
  id: string
  slug: string
  name: string
  type: "user" | "persona" | "bot" | "broadcast"
  avatarEmoji?: string
  avatarUrl?: string
  isCurrentUser?: boolean
  /**
   * A personal (owner-scoped) persona. Only the owner ever receives these rows,
   * but the owner can hold a personal and a workspace persona on the same slug
   * (per-owner slug namespace), so the suggestion list tags personal rows to
   * disambiguate two identically-labelled `@slug` entries (user-scoped-personas).
   */
  isPersonal?: boolean
  /**
   * A personal bot owned by someone else: the mention renders and resolves,
   * but the backend dispatches invocations for the owner only — surfaces must
   * signal that mentioning it will not trigger a response.
   */
  mentionOnly?: boolean
}

export interface ChannelItem {
  id: string
  slug: string
  name: string
  type: "channel" | "scratchpad"
  memberCount?: number
}

/**
 * Where a slash command is allowed to surface in the composer.
 *
 * - `"message"` commands take over the whole message (they're dispatched as a
 *   command, not embedded in prose), so they only appear when the `/` is the
 *   sole content of the message — e.g. `/invite`, `/discuss-with-ariadne`.
 * - `"inline"` commands insert into the surrounding text and may be triggered
 *   mid-sentence — e.g. the memo embed.
 *
 * Omitted = `"message"` (the safe default for server-dispatched commands).
 */
export type CommandPlacement = "inline" | "message"

export interface CommandItem {
  name: string
  description: string
  category?: string
  kind?: CommandKind
  scope?: CommandScope
  args?: CommandArgumentInfo[]
  /**
   * Client-action id. When present the suggestion list invokes the matching
   * handler directly instead of inserting a `/command` node that'd be sent
   * to the backend. Used for UI-only commands like `/discuss-with-ariadne`.
   */
  clientActionId?: string
  /** See {@link CommandPlacement}. Defaults to `"message"` when omitted. */
  placement?: CommandPlacement
}

export interface SuggestionState<T> {
  items: T[]
  query: string
  selectedIndex: number
  clientRect: (() => DOMRect | null) | null
}

export interface SuggestionCommand<T> {
  items: T[]
  query: string
  range: Range
  clientRect: (() => DOMRect | null) | null
}
