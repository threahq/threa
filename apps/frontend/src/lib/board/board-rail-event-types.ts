import { BOARD_EVENT_ROW_TYPES, type EventType } from "@threa/types"

/** Messages, board rows, and the patch-only events folded into scheduled and delegation cards. */
export const BOARD_RAIL_EVENT_TYPES: EventType[] = [
  ...BOARD_EVENT_ROW_TYPES,
  "agent:follow_up_cancelled",
  "delegation:status_changed",
  "message_created",
]
