import {
  COMMAND_EVENT_TYPES,
  type CommandCompletedPayload,
  type CommandDispatchedPayload,
  type CommandEventType,
  type CommandFailedPayload,
  type StreamEvent,
} from "@threahq/types"

/**
 * Command-group primitives, shared by the timeline (`event-list.tsx`) and the
 * board/conversation projection (`lib/board/board-event-rows.ts`). One definition
 * so both views group a command the same way and apply the same author rule.
 * Works on any {@link StreamEvent}-shaped row (the board passes IDB `CachedEvent`s,
 * a structural superset).
 */

export function isCommandEvent(event: Pick<StreamEvent, "eventType">): boolean {
  return COMMAND_EVENT_TYPES.includes(event.eventType as CommandEventType)
}

export function getCommandId(event: Pick<StreamEvent, "eventType" | "payload">): string | null {
  if (!isCommandEvent(event)) return null
  const payload = event.payload as CommandDispatchedPayload | CommandCompletedPayload | CommandFailedPayload
  return payload.commandId ?? null
}

/**
 * Command events are delivered stream-wide over the socket while REST filters
 * them author-side, so every surface that draws them re-applies the author rule
 * itself — otherwise a card leaks another member's invocations.
 */
export function isOwnCommandEvent(
  event: Pick<StreamEvent, "actorId">,
  currentUserId: string | null | undefined
): boolean {
  return event.actorId === currentUserId
}
