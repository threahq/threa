import { EVENT_TYPES, type EventType } from "./constants"

/**
 * How a stream event resolves to a conversation on the board / conversation-panel
 * projection (the "second view" of a stream's content). This is *render-side
 * placement* — deliberately distinct from `conversations.message_ids`, which is
 * the backend membership truth. It answers "which card does this row draw on,"
 * not "is this a member of the conversation."
 *
 * - `self-message`     — the row IS a member message; keyed by its own messageId.
 * - `trigger-message`  — keyed by the invoking message id (agent sessions: the
 *                        session shows on the conversation its trigger belongs to).
 * - `source-conversation` — the payload names the conversation directly
 *                        (memos:captured → `conversationId`,
 *                        agent:follow_up_scheduled → `sourceConversationId`).
 * - `none`             — never drawn on conversation surfaces (channel chrome like
 *                        member/description events, author-scoped command events,
 *                        and patch-style rows).
 */
export type ConversationRef = "self-message" | "trigger-message" | "source-conversation" | "none"

/**
 * The single description of how a stream event participates in the two views over
 * a stream's content — the chronological timeline (the room) and the board /
 * conversation projection (topic cards + side panel).
 *
 * There is exactly one entry per {@link EventType} in {@link STREAM_ROW_SPEC}, and
 * the record is `Record<EventType, StreamRowSpec>` (not `Partial`) on purpose:
 * adding a member to `EVENT_TYPES` is a compile error until it declares how BOTH
 * views treat it. That is the anti-drift device — before this, the timeline knew
 * ~8 scattered constant sets and the board knew none, so a new row kind could ship
 * to one view and be silently invisible in the other (INV-61 contiguity for the
 * timeline; a hard `message_created` Dexie filter for the board).
 *
 * The existing scattered sets remain the live wiring for now; the guard test
 * (`stream-rows.test.ts`) proves this spec's derived sets match them exactly, so
 * they can be re-derived and deleted in a follow-up without behavior change.
 */
export interface StreamRowSpec {
  /**
   * Renders as its own standalone row (a message body, a system notice, a memo
   * capture, a scheduled follow-up). False for rows that are grouped before
   * rendering (`grouping != null`) or delivered as patches (`patchesRow`).
   */
  rendersAsOwnRow: boolean
  /**
   * Grouped with adjacent same-group events into one rendered card before it
   * draws: command lifecycle (dispatched/completed/failed) and agent-session
   * lifecycle (started/completed/failed/deleted). `null` for ungrouped rows.
   */
  grouping: "command" | "session" | null
  /**
   * Participates in same-author continuation grouping (consecutive messages by
   * one actor within a short window collapse their repeated header). True only
   * for message bodies. Mirror of the timeline's `MESSAGE_EVENT_TYPES`.
   */
  authorGroupable: boolean
  /**
   * Delivered live as a payload *patch* onto an existing row rather than an
   * appended row (edits, reactions, deletes, follow-up cancels). Patches never
   * take a broadcast slot. Mirror of the timeline's `ZERO_HEIGHT_EVENT_TYPES`
   * minus the grouped types.
   */
  patchesRow: boolean
  /**
   * Consumes a dense per-stream `broadcastSequence` slot — every member receives
   * it as an appended timeline row, so a missing number is always a real gap
   * (INV-61). Exact mirror of `TIMELINE_BROADCAST_EVENT_TYPES`.
   */
  broadcastSlot: boolean
  /** {@link ConversationRef}: how the board/panel projection places this row. */
  conversationRef: ConversationRef
  /**
   * Whether appending this event bumps `conversations.last_activity_at` (moves the
   * card in the board's activity order). Contract: only a member message bumps —
   * every render-only agent/memo/follow-up row is `false`, so it can appear on a
   * card without perturbing the board's activity sort or its frozen stable view
   * ("Agents on the board — traces visible, never bumping", board-view-design.md).
   */
  bumps: boolean
}

const MESSAGE: StreamRowSpec = {
  rendersAsOwnRow: true,
  grouping: null,
  authorGroupable: true,
  patchesRow: false,
  broadcastSlot: true,
  conversationRef: "self-message",
  bumps: true,
}

/** A live patch onto an existing row (edit / reaction / delete / cancel). */
const PATCH: StreamRowSpec = {
  rendersAsOwnRow: false,
  grouping: null,
  authorGroupable: false,
  patchesRow: true,
  broadcastSlot: false,
  conversationRef: "none",
  bumps: false,
}

/** Channel chrome: a broadcast row in the timeline, never a board/topic row. */
const CHROME_BROADCAST: StreamRowSpec = {
  rendersAsOwnRow: true,
  grouping: null,
  authorGroupable: false,
  patchesRow: false,
  broadcastSlot: true,
  conversationRef: "none",
  bumps: false,
}

const AGENT_SESSION: StreamRowSpec = {
  rendersAsOwnRow: false,
  grouping: "session",
  authorGroupable: false,
  patchesRow: false,
  broadcastSlot: true,
  conversationRef: "trigger-message",
  bumps: false,
}

const COMMAND: StreamRowSpec = {
  rendersAsOwnRow: false,
  grouping: "command",
  authorGroupable: false,
  patchesRow: false,
  broadcastSlot: false,
  conversationRef: "none",
  bumps: false,
}

export const STREAM_ROW_SPEC: Record<EventType, StreamRowSpec> = {
  message_created: MESSAGE,
  // Legacy/no-longer-emitted, but still renders as a message body where present
  // (author-groupable like `message_created`); it rides along without a broadcast
  // slot, so it is not a board topic row.
  companion_response: {
    rendersAsOwnRow: true,
    grouping: null,
    authorGroupable: true,
    patchesRow: false,
    broadcastSlot: false,
    conversationRef: "none",
    bumps: false,
  },
  message_edited: PATCH,
  reaction_added: PATCH,
  reaction_removed: PATCH,
  // A soft-delete: the board rail folds it into the `message_created` row's
  // `deletedAt`, so it is a patch there; the timeline draws a small tombstone.
  message_deleted: PATCH,

  member_joined: CHROME_BROADCAST,
  member_added: CHROME_BROADCAST,
  member_left: CHROME_BROADCAST,
  description_set: CHROME_BROADCAST,
  // A durable-brief change (roadmap 4.2): a broadcast row in the timeline, never
  // a board/topic row — the brief is stream-level standing context, not anchored
  // to a conversation.
  brief_updated: CHROME_BROADCAST,
  stream_archived: CHROME_BROADCAST,
  stream_unarchived: CHROME_BROADCAST,
  // Source-side tombstone for a move; the board does not surface move notices.
  "messages:moved": CHROME_BROADCAST,
  // Legacy/no-longer-emitted; rendered as a plain system notice, no slot.
  thread_created: {
    rendersAsOwnRow: true,
    grouping: null,
    authorGroupable: false,
    patchesRow: false,
    broadcastSlot: false,
    conversationRef: "none",
    bumps: false,
  },

  command_dispatched: COMMAND,
  command_completed: COMMAND,
  command_failed: COMMAND,

  "agent_session:started": AGENT_SESSION,
  "agent_session:completed": AGENT_SESSION,
  "agent_session:failed": AGENT_SESSION,
  "agent_session:interrupted": AGENT_SESSION,
  "agent_session:deleted": AGENT_SESSION,

  // GAM memory capture — provenance carries the source `conversationId`.
  "memos:captured": {
    rendersAsOwnRow: true,
    grouping: null,
    authorGroupable: false,
    patchesRow: false,
    broadcastSlot: true,
    conversationRef: "source-conversation",
    bumps: false,
  },
  // Scheduled agent follow-up — payload carries `sourceConversationId`.
  "agent:follow_up_scheduled": {
    rendersAsOwnRow: true,
    grouping: null,
    authorGroupable: false,
    patchesRow: false,
    broadcastSlot: true,
    conversationRef: "source-conversation",
    bumps: false,
  },
  // A patch that flips the matching scheduled card to "Cancelled" — not its own row.
  "agent:follow_up_cancelled": PATCH,

  // Delegated-task hand-off (roadmap 5.1) — payload carries `sourceConversationId`.
  "delegation:created": {
    rendersAsOwnRow: true,
    grouping: null,
    authorGroupable: false,
    patchesRow: false,
    broadcastSlot: true,
    conversationRef: "source-conversation",
    bumps: false,
  },
  // A patch that advances the matching delegation card's status — not its own row.
  "delegation:status_changed": PATCH,
}

/**
 * Event types the board / conversation-panel projection draws as their own
 * (non-message) rows, resolved to a conversation via `conversationRef`. Derived
 * from {@link STREAM_ROW_SPEC} so a newly-registered conversation-scoped row kind
 * joins the board automatically instead of requiring a second, separate wiring —
 * this is the drift the spec exists to prevent.
 */
export const BOARD_EVENT_ROW_TYPES: EventType[] = EVENT_TYPES.filter(
  (type) =>
    STREAM_ROW_SPEC[type].conversationRef === "trigger-message" ||
    STREAM_ROW_SPEC[type].conversationRef === "source-conversation"
)
