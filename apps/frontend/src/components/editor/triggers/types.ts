import type { CommandArgumentInfo, CommandKind, CommandScope } from "@threa/types"

/**
 * Base interface for mentionable entities (users, personas, broadcast).
 */
export interface Mentionable {
  id: string
  slug: string
  name: string
  type: "user" | "persona" | "bot" | "broadcast"
  avatarEmoji?: string
  avatarUrl?: string
  /** True if this is the current user */
  isCurrentUser?: boolean
}

/**
 * Interface for channel/stream links.
 */
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

/**
 * Interface for slash commands.
 */
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

/**
 * Suggestion state passed to the popup component.
 */
export interface SuggestionState<T> {
  items: T[]
  query: string
  selectedIndex: number
  clientRect: (() => DOMRect | null) | null
}

/**
 * Command interface for controlling the suggestion popup from TipTap.
 */
export interface SuggestionCommand<T> {
  items: T[]
  query: string
  range: Range
  clientRect: (() => DOMRect | null) | null
}
