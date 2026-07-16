import { memo, useMemo } from "react"
import {
  COMMAND_EVENT_TYPES,
  ConversationStatuses,
  type CommandEventType,
  type StreamEvent,
  type CommandDispatchedPayload,
  type CommandCompletedPayload,
  type CommandFailedPayload,
  type DelegationStatusChangedEventPayload,
  type BotAccessStatusChangedEventPayload,
} from "@threa/types"
import { getSessionId, getSessionSlotKey, getTriggerMessageId } from "./session-grouping"
import type { MessageAgentActivity } from "@/hooks"
import { useSocket, useCoordinatedLoading } from "@/contexts"
import { useSteerAgentSession, useStopAgentSession } from "@/hooks"
import { Loader2 } from "lucide-react"
import { EventItem } from "./event-item"
import { AgentSessionEvent } from "./agent-session-event"
import { CommandEvent } from "./command-event"
import { UnreadDivider } from "./unread-divider"
import { DayDivider } from "./day-divider"
import { localStartOfDayMs } from "@/lib/dates"
import { Skeleton } from "@/components/ui/skeleton"
import { ConversationOverlayRow } from "./conversation-overlay/conversation-overlay"
import type {
  ConversationOverlayContext,
  ConversationOverlayModel,
  ConversationRevival,
  ConversationRowAnnotation,
} from "./conversation-overlay/model"
import type { ConversationWithStaleness } from "@threa/types"

interface EventListProps {
  timelineItems: TimelineItem[]
  isLoading: boolean
  workspaceId: string
  streamId: string
  highlightMessageId?: string | null
  firstUnreadEventId?: string
  isDividerDimmed?: boolean
  agentActivity?: Map<string, MessageAgentActivity>
  /** Hide session group cards (used in channels where responses go to threads) */
  hideSessionCards?: boolean
  /** Event IDs that just arrived via socket and should flash briefly */
  newMessageIds?: Set<string>
  /** True when the viewer is a member of this stream — gates the bot-access card's Approve/Deny. */
  viewerIsMember?: boolean
  batch?: BatchTimelineState
  /** Set while the conversation overlay is active; decorates message rows. */
  conversationOverlay?: ConversationOverlayContext
}

/**
 * Shared batch-selection state passed from `StreamContent` into timeline rows.
 * Enabled rows render selection controls and expose drag/drop target feedback.
 */
export interface BatchTimelineState {
  /** Whether batch-selection mode is active. */
  enabled: boolean
  /**
   * Whether this batch uses the drag-onto-a-target gesture (move-to-thread). When
   * false (split-conversation), rows must NOT get `touch-action: none` — the user
   * scrolls the timeline by touch to reach far-apart messages, and selection is a
   * plain tap toggle, so suppressing native pan would trap touch users.
   */
  dragSelect: boolean
  /** Message IDs currently selected for the batch operation. */
  selectedMessageIds: Set<string>
  /** Message IDs that are not valid drop targets during a drag. */
  invalidTargetIds: Set<string>
  /** Valid drop target currently hovered during drag, or `null`. */
  hoveredTargetId: string | null
  /** Toggles one message in the current selection. */
  onToggleMessage: (messageId: string) => void
}

function isCommandEvent(event: StreamEvent): boolean {
  return COMMAND_EVENT_TYPES.includes(event.eventType as CommandEventType)
}

function getCommandId(event: StreamEvent): string | null {
  if (!isCommandEvent(event)) return null
  const payload = event.payload as CommandDispatchedPayload | CommandCompletedPayload | CommandFailedPayload
  return payload.commandId
}

/**
 * Represents either a regular event, a group of command events, or a group of agent
 * session events.
 *
 * For `event` items rendering a message (`message_created` or `companion_response`),
 * optional author-grouping metadata (`groupContinuation`, `gutterTime`) annotates
 * consecutive same-author runs so the renderer can collapse the repeated header
 * row. Each message still occupies its own TimelineItem — Virtuoso measures one
 * row per message, preserving scroll-to-message precision and per-item
 * re-measurement on reactions/edits.
 */
export type TimelineItem =
  | {
      type: "event"
      event: StreamEvent
      /**
       * True when this event is a continuation of a same-author run (messages 2..N
       * within 5 minutes of the previous message, no non-message event between).
       * The head of a run carries `groupContinuation: false | undefined`. The
       * renderer formats the gutter time label from `event.createdAt` at render
       * time so the format tracks user preferences (INV-42).
       */
      groupContinuation?: boolean
      /**
       * Conversation membership annotation, stamped by
       * `annotateConversationRows` only while the conversation overlay is
       * active. Absent on non-message events and when the overlay is off.
       */
      conversationRow?: ConversationRowAnnotation
      /**
       * Topic-revival annotation, stamped always-on by
       * `annotateConversationRevivals` on channel/DM timelines. Present only on
       * a message that reopens a scattered conversation; drives the on-message
       * provenance chip. Absent on non-message events and non-revival rows.
       */
      revival?: ConversationRevival
    }
  | { type: "command_group"; commandId: string; events: StreamEvent[] }
  | { type: "session_group"; sessionId: string; sessionVersion: number; events: StreamEvent[] }
  /**
   * An in-place loading placeholder for a detected hole in the broadcast
   * chain (INV-61): events are known to be missing right after
   * `afterEventId` and a scoped backfill is in flight. Rendering the
   * placeholder where the events belong means the backfill resolves it in
   * place — a missed message never pops in above rows already on screen.
   */
  | { type: "gap"; afterEventId: string; missingCount: number }
  /**
   * A placeholder row prepended at the head of the timeline while an older
   * page is in flight (infinite scroll), so the space the page will fill
   * reads as loading instead of blank. Visually similar to `gap` but
   * semantically different — a gap is known-missing events (INV-61
   * contiguity), a skeleton is just a page fetch in flight — so they stay
   * separate item types.
   */
  | { type: "skeleton"; index: number }
  /**
   * A day boundary between rows from different local calendar days (INV-42).
   * Purely client-derived — not a server event, so it consumes no
   * `broadcastSequence` and never participates in contiguity/hole detection
   * (INV-61). `dayStartMs` is the local start-of-day key; the renderer formats
   * the label ("Today"/"Yesterday"/date) at render time so it stays current.
   */
  | { type: "day_divider"; dayStartMs: number }

/** Event types that participate in author-grouping (render as message bodies). */
const MESSAGE_EVENT_TYPES = new Set<StreamEvent["eventType"]>(["message_created", "companion_response"])

/** Window (ms) within which same-author messages collapse into a single run. */
const AUTHOR_GROUP_WINDOW_MS = 5 * 60 * 1000

function isGroupableMessage(event: StreamEvent): boolean {
  if (!MESSAGE_EVENT_TYPES.has(event.eventType)) return false
  // Soft-deleted messages render as a placeholder, not a grouped message body.
  const payload = event.payload as { deletedAt?: string } | undefined
  return !payload?.deletedAt
}

/**
 * Walks a timeline and annotates consecutive same-author `message_created` /
 * `companion_response` events with author-grouping metadata. Same actor + actor
 * type + within 5 minutes + no non-message item between = continuation.
 *
 * Any non-event TimelineItem (command/session groups), non-message event type,
 * or deleted/pending message breaks the current run.
 *
 * Pure and export-only so the grouping rule can be covered in isolation (INV-56
 * does not apply — this runs per-stream on already-fetched events).
 */
export function annotateAuthorGroups(items: TimelineItem[]): TimelineItem[] {
  let previousMessage: { event: StreamEvent; timeMs: number } | null = null
  return items.map((item) => {
    if (item.type !== "event" || !isGroupableMessage(item.event)) {
      previousMessage = null
      return item
    }
    const currentTimeMs = new Date(item.event.createdAt).getTime()
    const belongsToRun =
      previousMessage != null &&
      previousMessage.event.actorId === item.event.actorId &&
      previousMessage.event.actorType === item.event.actorType &&
      currentTimeMs - previousMessage.timeMs <= AUTHOR_GROUP_WINDOW_MS

    previousMessage = { event: item.event, timeMs: currentTimeMs }

    if (!belongsToRun) return item
    return { ...item, groupContinuation: true }
  })
}

/**
 * Stamps message timeline items with their primary-conversation membership
 * for the conversation overlay. `blockStart` marks the first message of each
 * contiguous run of one conversation — that's where the floating topic chip
 * renders.
 *
 * Non-message items (session/command cards, membership events) do not break
 * a run: a session card in the middle of a conversation shouldn't restart
 * the chip. Unassigned messages (extraction pending, or membership unknown)
 * carry `conversationId: null`, render undecorated, and never start a block.
 *
 * Pure and export-only, mirroring `annotateAuthorGroups`.
 */
export function annotateConversationRows(items: TimelineItem[], model: ConversationOverlayModel): TimelineItem[] {
  let previousConversationId: string | null = null
  return items.map((item) => {
    if (item.type !== "event" || !isGroupableMessage(item.event)) return item
    const messageId = (item.event.payload as { messageId?: string })?.messageId
    if (!messageId) return item
    const conversationId = model.conversationIdByMessageId.get(messageId) ?? null
    const blockStart = conversationId != null && conversationId !== previousConversationId
    previousConversationId = conversationId
    return { ...item, conversationRow: { conversationId, blockStart } }
  })
}

/**
 * Stamp message rows that switch conversation with a {@link ConversationRevival}
 * for the always-on provenance chip (board-view-design.md §"Conversations as
 * soft threads", mechanism A) — no dependence on the conversation overlay being
 * painted.
 *
 * Two different trigger rules for two different mechanisms (Kris's call,
 * superseding an earlier server-timestamped design):
 *
 * - **Declared** (Mechanism C — a board/panel reply that names its conversation
 *   at send time): chips on every *block start* — the previous conversation-
 *   bearing row differs from this one — full stop, regardless of whether this
 *   conversation has appeared anywhere in the loaded timeline before. This is
 *   the reported case: a reply routed via the board into a long-dormant
 *   conversation, with nothing else of it loaded, must still ground the
 *   reader. No history requirement.
 * - **Async-classified** (Mechanism A — the boundary extractor's `membership`
 *   map, ordinary ambient chat with no declaration): still requires the
 *   conversation to have been genuinely seen earlier IN THIS RENDER (`seen`).
 *   Unconditional block-start chipping here would spam a chip under nearly
 *   every message in a bursty channel — the extractor freely mints many
 *   small, unrelated one- or two-message conversations for ordinary rapid
 *   chat, and each one is a "block start" relative to the last (caught live:
 *   an E2E fixture posting 20 sequential filler messages chipped literally
 *   all of them, one colliding on text with its own chip). Kris's stated
 *   motivation was board-driven conversation jumps, not ambient chat, so the
 *   noisier rule is confined to the mechanism it was asked for.
 *
 * `previousActivityAt` is filled in when it happens to be locally known (the
 * conversation's earlier member is loaded into this render) and left
 * `undefined` otherwise — a declared revival with nothing else loaded renders
 * the topic without a time tail rather than guessing.
 *
 * `membership` is the always-on `messageId → conversationId` map
 * (`buildMessageConversationMap`), including cross-stream secondary members. A
 * message that declared its conversation at send time overrides it from its own
 * payload (`declaredConversationId`) so its membership needs no list round-trip.
 * Non-message items (session/command cards) and unassigned message rows don't
 * break a run — only a different real conversation does. This diverges from
 * `annotateConversationRows` (which resets its run on an unassigned row for
 * coloring): a lone unclustered aside between two members of the same topic is
 * not a topic switch, so it must not manufacture a chip. Pure and export-only
 * for isolated coverage.
 */
export function annotateConversationRevivals(
  items: TimelineItem[],
  membership: ReadonlyMap<string, string>,
  conversationsById: ReadonlyMap<string, ConversationWithStaleness>
): TimelineItem[] {
  const seen = new Set<string>()
  const lastActivityByConversation = new Map<string, string>()
  let previousConversationId: string | null = null
  return items.map((item) => {
    if (item.type !== "event" || !isGroupableMessage(item.event)) return item
    const payload = item.event.payload as { messageId?: string; declaredConversationId?: string }
    const messageId = payload?.messageId
    if (!messageId) return item
    // A message that DECLARED its conversation at send time carries the id on its
    // payload (board-view-design.md Mechanism C) — prefer it so the chip renders
    // the instant the message lands, without waiting for the async membership
    // list. Falls back to the async `membership` map for classifier-assigned
    // messages (Mechanism A). The topic label still resolves from
    // `conversationsById` (loaded per-stream); a declared-but-not-yet-listed
    // conversation shows the generic label until the list catches up.
    //
    // Fallback exception (resolved decision 3, board-view-design.md): a later
    // extraction pass can merge/retire the declared conversation into an empty
    // `resolved` shell — still present in `conversationsById` (the read query
    // returns it) but holding no messages. Deep-linking that shell points at a
    // dead conversation, so fall back to the membership map, which after a merge
    // resolves the message to its surviving home. A declared id merely not-yet-
    // listed (absent from `conversationsById`) is NOT retired — keep it, so the
    // flicker-free just-sent case still wins over a not-yet-loaded list. The
    // `status` check runs before `.messageIds` so a row missing that field can't
    // be misread as retired.
    const declared = payload.declaredConversationId
    const declaredRow = declared != null ? conversationsById.get(declared) : undefined
    const declaredRetired = declaredRow?.status === ConversationStatuses.RESOLVED && declaredRow.messageIds.length === 0
    const isDeclared = !declaredRetired && declared != null
    const conversationId = (declaredRetired ? undefined : declared) ?? membership.get(messageId) ?? null
    let revival: ConversationRevival | undefined
    if (conversationId != null) {
      const blockStart = conversationId !== previousConversationId
      // Declared: no history required (see doc comment). Async-classified:
      // still needs to have been genuinely seen before, to avoid chipping
      // nearly every message in ordinary bursty chat.
      if (blockStart && (isDeclared || seen.has(conversationId))) {
        revival = {
          conversationId,
          topicSummary: conversationsById.get(conversationId)?.topicSummary ?? null,
          previousActivityAt: lastActivityByConversation.get(conversationId),
        }
      }
      seen.add(conversationId)
      lastActivityByConversation.set(conversationId, item.event.createdAt)
      // Only a real conversation breaks the run. An unassigned message
      // (extraction pending, or a genuinely unclustered aside) must NOT reset
      // this — otherwise the next same-conversation message reads as a block
      // start and gets a false chip even though no *other* topic intervened,
      // just one stray message. A topic switch requires a different
      // conversation between the prior member and now, not merely a gap.
      previousConversationId = conversationId
    }
    return revival ? { ...item, revival } : item
  })
}

/** Event types that render as null in EventItem (handled elsewhere or invisible) */
const ZERO_HEIGHT_EVENT_TYPES = new Set([
  "reaction_added",
  "reaction_removed",
  "command_dispatched",
  "command_completed",
  "command_failed",
  "agent_session:started",
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:interrupted",
  "agent_session:deleted",
  // Cancellation is a patch on the scheduled card (flips it to "Cancelled" via
  // collectCancelledFollowUpIds), not a row of its own — renders null.
  "agent:follow_up_cancelled",
  // Status changes patch the delegation card (collectDelegationStatusPatches).
  "delegation:status_changed",
  // Status changes patch the bot-access request card (collectBotAccessStatusPatches).
  "bot_access:status_changed",
])

/**
 * Filters out timeline items that would render as zero-height elements.
 * Must be applied before computing virtualizer count/keys to prevent overlap.
 */
export function filterVisibleItems(items: TimelineItem[], hideSessionCards?: boolean): TimelineItem[] {
  return items.filter((item) => {
    if (item.type === "session_group" && hideSessionCards) return false
    if (item.type === "event" && ZERO_HEIGHT_EVENT_TYPES.has(item.event.eventType)) return false
    return true
  })
}

/**
 * Find the messageId of the first user-authored message in the timeline
 * (smallest sequence). Used to anchor the context-bag attachment badge on
 * the conversation's opening message — null when the timeline has no user
 * messages yet (so the badge stays in the composer strip).
 *
 * Restricted to `message_created` (user authored) on purpose: in a bag-
 * attached scratchpad the conversation always opens with the user's first
 * question. If a `companion_response` ever lands first in render order
 * (offline-reconnect ordering glitch, agent edge case), we'd rather hide
 * the badge than mis-anchor it to Ariadne's reply.
 */
export function findFirstMessageId(items: TimelineItem[]): string | undefined {
  for (const item of items) {
    if (item.type !== "event") continue
    if (item.event.eventType !== "message_created") continue
    const messageId = (item.event.payload as { messageId?: string })?.messageId
    if (messageId) return messageId
  }
  return undefined
}

/**
 * Collect the followUpIds cancelled within the loaded window, from the
 * `agent:follow_up_cancelled` rows. A scheduled card reads membership to render
 * its cancelled state for every viewer (roadmap 1.3), so the Cancel affordance
 * reflects the authoritative timeline, not just the clicking session.
 */
export function collectCancelledFollowUpIds(items: TimelineItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.type !== "event" || item.event.eventType !== "agent:follow_up_cancelled") continue
    const followUpId = (item.event.payload as { followUpId?: string })?.followUpId
    if (followUpId) ids.add(followUpId)
  }
  return ids
}

/**
 * Collect the latest `delegation:status_changed` payload per delegationId in
 * the loaded window (items are in sequence order, so the last patch wins). A
 * delegation card reads its entry to render the authoritative live status for
 * every viewer (roadmap 5.2) — claim, progress, completion, cancel — without a
 * fetch.
 */
export function collectDelegationStatusPatches(
  items: TimelineItem[]
): Map<string, DelegationStatusChangedEventPayload> {
  const patches = new Map<string, DelegationStatusChangedEventPayload>()
  for (const item of items) {
    if (item.type !== "event" || item.event.eventType !== "delegation:status_changed") continue
    const payload = item.event.payload as DelegationStatusChangedEventPayload | undefined
    if (payload?.delegationId) patches.set(payload.delegationId, payload)
  }
  return patches
}

/**
 * Collect the latest `bot_access:status_changed` payload per requestId in the
 * loaded window (items are in sequence order, so the last patch wins). A
 * request card reads its entry to render the authoritative terminal state for
 * every viewer — approved / denied — without a fetch.
 */
export function collectBotAccessStatusPatches(items: TimelineItem[]): Map<string, BotAccessStatusChangedEventPayload> {
  const patches = new Map<string, BotAccessStatusChangedEventPayload>()
  for (const item of items) {
    if (item.type !== "event" || item.event.eventType !== "bot_access:status_changed") continue
    const payload = item.event.payload as BotAccessStatusChangedEventPayload | undefined
    if (payload?.requestId) patches.set(payload.requestId, payload)
  }
  return patches
}

/**
 * Index of the timeline item whose event renders `messageId`, or -1 when the
 * message is not in `items`.
 *
 * Deep-link scroll resolves this against the *current* timeline on every retry
 * tick, not once up front: the event window shifts under the retry loop
 * (infinite-scroll prepends, live messages, a jump-window swap), so a stale
 * captured index can fall outside the array Virtuoso currently holds. Feeding
 * an out-of-range index to `scrollToIndex` drives react-virtuoso's offset-tree
 * binary search to an undefined node and crashes the whole route, so callers
 * must re-resolve and bounds-check before every imperative scroll.
 */
export function findMessageItemIndex(items: TimelineItem[], messageId: string): number {
  // Deep-link targets are usually message ids, but non-message rows (e.g. a
  // delegation card) are addressed by their `event_…` id — the two prefixes
  // never collide, so one lookup serves both.
  return items.findIndex(
    (item) =>
      item.type === "event" &&
      ((item.event.payload as { messageId?: string })?.messageId === messageId || item.event.id === messageId)
  )
}

/**
 * Index of the timeline item carrying `eventId` (the row, command group, or
 * session group whose first event matches). Mirrors `isFirstUnread` so the
 * scroll target resolves to the same item that renders the unread divider.
 */
export function findEventItemIndex(items: TimelineItem[], eventId: string): number {
  return items.findIndex((item) => {
    if (item.type === "event") return item.event.id === eventId
    if (item.type === "command_group" || item.type === "session_group") return item.events[0]?.id === eventId
    return false
  })
}

/**
 * Index of the timeline item addressed by `targetId` — a message id, a plain
 * event id, or the first-event id of a command/session group. The union of
 * `findMessageItemIndex` and `findEventItemIndex`, for scroll targets that can
 * be any row the unread divider anchors on (a session card's first unread is
 * an `event_…` id inside a group, which the message lookup alone misses).
 */
export function findTimelineTargetIndex(items: TimelineItem[], targetId: string): number {
  const idx = findMessageItemIndex(items, targetId)
  return idx >= 0 ? idx : findEventItemIndex(items, targetId)
}

/** Returns a stable key string for a timeline item */
export function getTimelineItemKey(item: TimelineItem): string {
  switch (item.type) {
    case "command_group":
      return item.commandId
    case "session_group":
      return item.sessionId
    case "gap":
      return `gap:${item.afterEventId}`
    case "skeleton":
      return `skeleton:older:${item.index}`
    case "day_divider":
      return `day:${item.dayStartMs}`
    default:
      return item.event.id
  }
}

/** Number of skeleton placeholder rows prepended while an older page is in flight. */
export const OLDER_SKELETON_COUNT = 4

/**
 * The skeleton placeholder items, as a module-level constant so both the item
 * identities and their keys are stable across renders while a fetch is in
 * flight — otherwise the row memo comparator and virtua's measurement cache
 * churn every frame.
 */
export const OLDER_SKELETON_ITEMS: readonly TimelineItem[] = Array.from(
  { length: OLDER_SKELETON_COUNT },
  (_, index) => ({ type: "skeleton" as const, index })
)

/** Whether a timeline item renders (or contains) the given event id. */
function itemContainsEvent(item: TimelineItem, eventId: string): boolean {
  switch (item.type) {
    case "command_group":
    case "session_group":
      return item.events.some((event) => event.id === eventId)
    case "gap":
    case "skeleton":
    case "day_divider":
      return false
    default:
      return item.event.id === eventId
  }
}

/**
 * Insert a `gap` placeholder item directly after the timeline item that
 * renders each hole's `afterEventId` (INV-61). Holes whose anchor row isn't
 * in the item list (e.g. the anchor was filtered out of this view) are
 * skipped — the backfill still runs; there is just no position to mark.
 */
export function injectGapItems(
  items: TimelineItem[],
  holes: Array<{ afterEventId: string; missingCount: number }>
): TimelineItem[] {
  if (holes.length === 0) return items
  const result: TimelineItem[] = []
  const holesByAnchor = new Map(holes.map((hole) => [hole.afterEventId, hole]))
  for (const item of items) {
    result.push(item)
    // An item can anchor MORE than one hole: a command/session group renders
    // several events as one card, and distinct holes can sit behind distinct
    // events inside it — emit a placeholder for each (map order preserves the
    // holes' ascending order). Deleting while iterating a Map is safe in JS.
    for (const [anchorId, hole] of holesByAnchor) {
      if (itemContainsEvent(item, anchorId)) {
        result.push({ type: "gap", afterEventId: hole.afterEventId, missingCount: hole.missingCount })
        holesByAnchor.delete(anchorId)
      }
    }
  }
  return result
}

/**
 * Local-day key (start-of-day ms) the row belongs to, or null for rows that
 * carry no day (gaps, skeletons). A `day_divider` reports the day it opens, so
 * the floating date header can read the topmost visible day off either a
 * message row or a divider. Command/session groups key off their first event.
 */
export function itemDayStartMs(item: TimelineItem): number | null {
  switch (item.type) {
    case "event":
      return localStartOfDayMs(new Date(item.event.createdAt))
    case "command_group":
    case "session_group": {
      const first = item.events[0]
      return first ? localStartOfDayMs(new Date(first.createdAt)) : null
    }
    case "day_divider":
      return item.dayStartMs
    default:
      return null
  }
}

/**
 * Insert a `day_divider` before the first row of each local calendar day
 * (INV-42). Walks render-ordered items; rows without a timestamp (gaps,
 * skeletons) pass through without opening or resetting the current day. Pure
 * and export-only for isolated coverage, mirroring `annotateAuthorGroups`.
 *
 * Run AFTER `filterVisibleItems` so a boundary lands above the first *visible*
 * row of a day, not above a zero-height event that never renders.
 */
export function injectDayDividers(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = []
  let currentDayMs: number | null = null
  for (const item of items) {
    const dayMs = itemDayStartMs(item)
    if (dayMs !== null) {
      // Never emit a divider above the very first timestamped row. Keeping a
      // real event at index 0 means its key changes on every older-page
      // prepend, so useTimelineScroll's first-key prepend detection still fires
      // and virtua holds the viewport (INV-21). A leading divider whose
      // `day:<ms>` key repeats across a same-day prepend would silently break
      // that hold.
      if (currentDayMs !== null && dayMs !== currentDayMs) {
        result.push({ type: "day_divider", dayStartMs: dayMs })
      }
      currentDayMs = dayMs
    }
    result.push(item)
  }
  return result
}

/**
 * Groups command events by commandId and agent session events by trigger-message slot.
 * For superseding sessions, the newer session replaces the old slot in place.
 */
export function groupTimelineItems(events: StreamEvent[], currentUserId: string | undefined): TimelineItem[] {
  const result: TimelineItem[] = []
  const commandGroups = new Map<string, StreamEvent[]>()
  const commandPositions = new Map<string, number>()
  const sessionSlots = new Map<string, { sessionId: string; sessionVersion: number; events: StreamEvent[] }>()
  const sessionSlotPositions = new Map<string, number>()
  const triggerBySessionId = new Map<string, string>()
  const sessionVersionById = new Map<string, number>()
  const nextVersionBySlot = new Map<string, number>()

  // Discover all trigger-message mappings up front so out-of-order reconnect
  // windows (e.g. completed arrives before started) still route every session
  // event to the same slot key.
  for (const event of events) {
    if (event.eventType !== "agent_session:started") continue
    const sessionId = getSessionId(event)
    const triggerMessageId = getTriggerMessageId(event)
    if (sessionId && triggerMessageId) {
      triggerBySessionId.set(sessionId, triggerMessageId)
    }
  }

  for (const event of events) {
    const commandId = getCommandId(event)
    const agentSessionId = getSessionId(event)

    if (commandId) {
      // Skip command events that aren't from the current user
      if (event.actorId !== currentUserId) continue

      if (!commandGroups.has(commandId)) {
        commandGroups.set(commandId, [])
        commandPositions.set(commandId, result.length)
        result.push({ type: "command_group", commandId, events: [] })
      }
      commandGroups.get(commandId)!.push(event)
    } else if (agentSessionId) {
      const knownTriggerMessageId = triggerBySessionId.get(agentSessionId) ?? null
      const sessionSlotKey = getSessionSlotKey(agentSessionId, knownTriggerMessageId)
      if (event.eventType === "agent_session:started") {
        const nextVersion = (nextVersionBySlot.get(sessionSlotKey) ?? 0) + 1
        nextVersionBySlot.set(sessionSlotKey, nextVersion)
        sessionVersionById.set(agentSessionId, nextVersion)
      }
      const sessionVersion = sessionVersionById.get(agentSessionId) ?? 1

      if (!sessionSlots.has(sessionSlotKey)) {
        sessionSlots.set(sessionSlotKey, { sessionId: agentSessionId, sessionVersion, events: [] })
        sessionSlotPositions.set(sessionSlotKey, result.length)
        result.push({ type: "session_group", sessionId: agentSessionId, sessionVersion, events: [] })
      }

      const slot = sessionSlots.get(sessionSlotKey)!

      if (event.eventType === "agent_session:started" && slot.sessionId !== agentSessionId) {
        slot.sessionId = agentSessionId
        slot.sessionVersion = sessionVersion
        slot.events = [event]
        continue
      }

      if (slot.sessionId !== agentSessionId) {
        continue
      }

      slot.events.push(event)
    } else {
      result.push({ type: "event", event })
    }
  }

  // Fill in command groups with their events
  for (const [commandId, events] of commandGroups) {
    const position = commandPositions.get(commandId)!
    result[position] = { type: "command_group", commandId, events }
  }

  // Fill in session slots with their active session events
  for (const [sessionSlotKey, slot] of sessionSlots) {
    const position = sessionSlotPositions.get(sessionSlotKey)!
    result[position] = {
      type: "session_group",
      sessionId: slot.sessionId,
      sessionVersion: slot.sessionVersion,
      events: slot.events,
    }
  }

  return result
}

/** Shared context for rendering a timeline item (used by both Virtuoso and non-virtualized paths) */
export interface TimelineItemRenderContext {
  workspaceId: string
  streamId: string
  highlightMessageId?: string | null
  firstUnreadEventId?: string
  isDividerDimmed?: boolean
  agentActivity?: Map<string, MessageAgentActivity>
  hideSessionCards?: boolean
  newMessageIds?: Set<string>
  /**
   * messageId of the first message in the stream. Drives the "context attached"
   * badge on the user's first message in a bag-attached scratchpad — same
   * mental model as a file upload that lives on the composer pre-send and
   * moves onto the message after send. Undefined when the stream has no
   * messages yet.
   */
  firstMessageId?: string
  sessionLiveCounts: Map<string, { stepCount: number; messageCount: number }>
  /** Live substep text per session (e.g. "Evaluating results…"). */
  sessionLiveSubsteps: Map<string, string | null>
  /** Click handler for the session card's Stop button. */
  onStopSession?: (sessionId: string) => void
  /** Prepare the composer to dispatch its next message through /steer when supported. */
  onSteerSession?: () => void
  /**
   * followUpIds that have a matching `agent:follow_up_cancelled` row in the
   * loaded window. Lets a scheduled follow-up card show its cancelled state
   * authoritatively for every viewer — not only the session that clicked
   * Cancel — and hides the (now no-op) Cancel button once it's cancelled.
   */
  cancelledFollowUpIds: Set<string>
  /** Latest `delegation:status_changed` payload per delegationId in the loaded window. */
  delegationStatusPatches: Map<string, DelegationStatusChangedEventPayload>
  /** Latest `bot_access:status_changed` payload per requestId in the loaded window. */
  botAccessStatusPatches: Map<string, BotAccessStatusChangedEventPayload>
  /**
   * True when the viewer is a member of this stream. Gates the bot-access
   * request card's Approve/Deny buttons — a non-member sees the card and its
   * status but cannot grant a bot standing access (brief decision 4).
   */
  viewerIsMember?: boolean
  batch?: BatchTimelineState
  /** Set while the conversation overlay is active; decorates message rows. */
  conversationOverlay?: ConversationOverlayContext
}

function isFirstUnread(item: TimelineItem, firstUnreadEventId?: string): boolean {
  if (!firstUnreadEventId) return false
  if (item.type === "gap" || item.type === "skeleton" || item.type === "day_divider") return false
  if (item.type === "command_group" || item.type === "session_group") {
    return item.events[0]?.id === firstUnreadEventId
  }
  return item.event.id === firstUnreadEventId
}

export interface TimelineItemContentProps {
  item: TimelineItem
  ctx: TimelineItemRenderContext
  /** Defer non-critical per-message hydration (presigns, previews, embeds). */
  deferSecondaryHydration: boolean
}

/** Renders a single timeline item. Used by virtua's row mapping and non-virtualized lists. */
function TimelineItemContentImpl({ item, ctx, deferSecondaryHydration }: TimelineItemContentProps) {
  const showUnreadDivider = isFirstUnread(item, ctx.firstUnreadEventId)

  let eventNode: React.ReactNode = null
  if (item.type === "event") {
    eventNode = (
      <EventItem
        event={item.event}
        workspaceId={ctx.workspaceId}
        streamId={ctx.streamId}
        highlightMessageId={ctx.highlightMessageId}
        agentActivity={ctx.hideSessionCards ? ctx.agentActivity : undefined}
        isNew={ctx.newMessageIds?.has(item.event.id)}
        deferSecondaryHydration={deferSecondaryHydration}
        cancelledFollowUpIds={ctx.cancelledFollowUpIds}
        delegationStatusPatches={ctx.delegationStatusPatches}
        botAccessStatusPatches={ctx.botAccessStatusPatches}
        viewerIsMember={ctx.viewerIsMember}
        batch={ctx.batch}
        // Continuations directly under an UnreadDivider promote back to head so
        // the first unread message in a run still reads as a fresh turn for the
        // viewer (fixes the "continuation starting an unread block" edge case).
        groupContinuation={item.groupContinuation && !showUnreadDivider}
        isFirstMessage={
          ctx.firstMessageId != null && (item.event.payload as { messageId?: string })?.messageId === ctx.firstMessageId
        }
        revival={item.revival}
      />
    )
    const overlayMessageId = (item.event.payload as { messageId?: string })?.messageId
    if (ctx.conversationOverlay && item.conversationRow && overlayMessageId) {
      eventNode = (
        <ConversationOverlayRow
          overlay={ctx.conversationOverlay}
          annotation={item.conversationRow}
          messageId={overlayMessageId}
          messageCreatedAt={item.event.createdAt}
          // Split-select keeps the overlay mounted for its coloring, but the row
          // is a selection toggle then — hide the single-message correction swatch
          // so it can't steal the tap (it renders outside the row's `inert` slot).
          selectionActive={ctx.batch?.enabled ?? false}
        >
          {eventNode}
        </ConversationOverlayRow>
      )
    }
  }

  const rowContent = (
    <>
      {item.type === "day_divider" && <DayDivider dayStartMs={item.dayStartMs} />}
      {item.type === "command_group" && (
        <div className="px-3 sm:px-6" data-event-id={item.events[0]?.id}>
          <CommandEvent events={item.events} />
        </div>
      )}
      {item.type === "gap" && (
        // Fixed-height single row: the placeholder reserves the hole's spot
        // and is replaced in place when the backfill lands — no content ever
        // inserts above rows the user is already reading (INV-61, INV-21).
        <div
          role="status"
          aria-label="Loading missed messages"
          className="flex h-8 items-center gap-2 px-3 sm:px-6 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Loading {item.missingCount === 1 ? "a missed message" : `${item.missingCount} missed messages`}…</span>
        </div>
      )}
      {item.type === "skeleton" && (
        // Fixed-height placeholder while an older page is in flight. The
        // floating "Loading older messages..." pill carries the announcement;
        // these rows are purely visual (aria-hidden) and are swapped for the
        // real rows in the same render the page lands.
        <div aria-hidden data-testid="older-skeleton-row" className="flex gap-3 px-4 py-3 sm:px-6">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      )}
      {item.type === "session_group" && !ctx.hideSessionCards && (
        <div className="px-3 sm:px-6" data-event-id={item.events[0]?.id}>
          <AgentSessionEvent
            events={item.events}
            sessionVersion={item.sessionVersion}
            liveCounts={ctx.sessionLiveCounts.get(item.sessionId)}
            liveSubstep={ctx.sessionLiveSubsteps.get(item.sessionId)}
            onStopSession={ctx.onStopSession}
            onSteerSession={ctx.onSteerSession}
          />
        </div>
      )}
      {eventNode}
    </>
  )

  return (
    <>
      {showUnreadDivider && <UnreadDivider isDimmed={ctx.isDividerDimmed} />}
      {/* The first-unread row reserves `pt-6` (24px) of top padding so the
          absolutely-positioned divider, centered at 12px (`top-3`), gets equal
          12px breathing room above and below the line — `pt-3` left the line
          flush against the message top. Only wrap when the divider shows so
          every other row keeps its spacing and DOM shape. */}
      {showUnreadDivider ? <div className="pt-6">{rowContent}</div> : rowContent}
    </>
  )
}

function getEventMessageId(event: StreamEvent): string | undefined {
  return (event.payload as { messageId?: string })?.messageId
}

function eventsArrayEqual(a: StreamEvent[], b: StreamEvent[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Whether two TimelineItems would render identically. `groupTimelineItems`
 * rebuilds every wrapper object on each run, but the underlying StreamEvent
 * objects keep identity when unchanged (structural sharing in
 * `useStreamEvents`), so identity of the contained events is the real signal.
 */
export function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
  if (a === b) return true
  if (a.type !== b.type) return false
  switch (a.type) {
    case "event": {
      const other = b as Extract<TimelineItem, { type: "event" }>
      if (a.event !== other.event || (a.groupContinuation ?? false) !== (other.groupContinuation ?? false)) {
        return false
      }
      // Overlay + revival annotation objects are rebuilt by every annotation
      // pass, so compare by value — identity would defeat the memo on each
      // data tick.
      return (
        (a.conversationRow?.conversationId ?? null) === (other.conversationRow?.conversationId ?? null) &&
        (a.conversationRow?.blockStart ?? false) === (other.conversationRow?.blockStart ?? false) &&
        (a.revival?.conversationId ?? null) === (other.revival?.conversationId ?? null) &&
        (a.revival?.topicSummary ?? null) === (other.revival?.topicSummary ?? null) &&
        (a.revival?.previousActivityAt ?? null) === (other.revival?.previousActivityAt ?? null)
      )
    }
    case "command_group": {
      const other = b as Extract<TimelineItem, { type: "command_group" }>
      return a.commandId === other.commandId && eventsArrayEqual(a.events, other.events)
    }
    case "session_group": {
      const other = b as Extract<TimelineItem, { type: "session_group" }>
      return (
        a.sessionId === other.sessionId &&
        a.sessionVersion === other.sessionVersion &&
        eventsArrayEqual(a.events, other.events)
      )
    }
    case "gap": {
      const other = b as Extract<TimelineItem, { type: "gap" }>
      return a.afterEventId === other.afterEventId && a.missingCount === other.missingCount
    }
    case "skeleton": {
      const other = b as Extract<TimelineItem, { type: "skeleton" }>
      return a.index === other.index
    }
    case "day_divider": {
      const other = b as Extract<TimelineItem, { type: "day_divider" }>
      return a.dayStartMs === other.dayStartMs
    }
  }
}

/**
 * Per-item props equality for the memoized row. `ctx` is rebuilt (new object,
 * new Maps/Sets) on every message arrival, agent-activity tick, or batch
 * interaction, so comparing ctx by identity would defeat the memo. Instead we
 * compare only what this *item* actually reads out of ctx — set membership
 * and map lookups rather than container identity.
 *
 * IMPORTANT: when adding a field to TimelineItemRenderContext that affects
 * row rendering, it must be compared here, or rows will render stale.
 *
 * Exported for isolated coverage (see event-list.test.ts); production callers
 * go through the memoized TimelineItemContent.
 */
export function timelineRowPropsEqual(prev: TimelineItemContentProps, next: TimelineItemContentProps): boolean {
  if (!timelineItemEqual(prev.item, next.item)) return false
  if (prev.deferSecondaryHydration !== next.deferSecondaryHydration) return false
  const p = prev.ctx
  const n = next.ctx
  if (
    p.workspaceId !== n.workspaceId ||
    p.streamId !== n.streamId ||
    p.hideSessionCards !== n.hideSessionCards ||
    p.isDividerDimmed !== n.isDividerDimmed ||
    p.onStopSession !== n.onStopSession
  ) {
    return false
  }
  const item = next.item
  if (isFirstUnread(item, p.firstUnreadEventId) !== isFirstUnread(item, n.firstUnreadEventId)) return false

  if (item.type === "session_group") {
    const prevCounts = p.sessionLiveCounts.get(item.sessionId)
    const nextCounts = n.sessionLiveCounts.get(item.sessionId)
    if (prevCounts?.stepCount !== nextCounts?.stepCount || prevCounts?.messageCount !== nextCounts?.messageCount) {
      return false
    }
    if (p.sessionLiveSubsteps.get(item.sessionId) !== n.sessionLiveSubsteps.get(item.sessionId)) return false
    return true
  }

  if (item.type !== "event") return true

  // The overlay context is memoized in useConversationOverlay and only gets a
  // new identity when focus/pending/model actually change — exactly the
  // moments decorated rows must repaint, so identity comparison is correct.
  if (p.conversationOverlay !== n.conversationOverlay) return false

  // A scheduled follow-up card repaints only when its own id enters/leaves the
  // cancelled set — set identity churns per cancel but membership for this id is
  // what the row reads.
  if (item.event.eventType === "agent:follow_up_scheduled") {
    const fid = (item.event.payload as { followUpId?: string })?.followUpId
    if (fid !== undefined && p.cancelledFollowUpIds.has(fid) !== n.cancelledFollowUpIds.has(fid)) return false
  }

  // A delegation card repaints only when its own latest patch changes. Payload
  // objects get fresh identity per data tick (Dexie re-emits new arrays), so
  // compare the fields the card actually renders, not object identity.
  if (item.event.eventType === "delegation:created") {
    const did = (item.event.payload as { delegationId?: string })?.delegationId
    if (
      did !== undefined &&
      !delegationPatchEqual(p.delegationStatusPatches.get(did), n.delegationStatusPatches.get(did))
    )
      return false
  }

  // A bot-access request card repaints when its own latest patch changes or when
  // the viewer's membership (which gates the Approve/Deny buttons) flips.
  if (item.event.eventType === "bot_access:requested") {
    if (p.viewerIsMember !== n.viewerIsMember) return false
    const rid = (item.event.payload as { requestId?: string })?.requestId
    if (rid !== undefined && !botAccessPatchEqual(p.botAccessStatusPatches.get(rid), n.botAccessStatusPatches.get(rid)))
      return false
  }

  const messageId = getEventMessageId(item.event)
  if ((p.highlightMessageId === messageId) !== (n.highlightMessageId === messageId)) return false
  if ((p.firstMessageId === messageId) !== (n.firstMessageId === messageId)) return false
  if ((p.newMessageIds?.has(item.event.id) ?? false) !== (n.newMessageIds?.has(item.event.id) ?? false)) return false
  if (messageId !== undefined && p.agentActivity?.get(messageId) !== n.agentActivity?.get(messageId)) return false

  const pb = p.batch
  const nb = n.batch
  if ((pb === undefined) !== (nb === undefined)) return false
  if (pb && nb && messageId !== undefined) {
    if (
      pb.enabled !== nb.enabled ||
      pb.onToggleMessage !== nb.onToggleMessage ||
      pb.selectedMessageIds.has(messageId) !== nb.selectedMessageIds.has(messageId) ||
      pb.invalidTargetIds.has(messageId) !== nb.invalidTargetIds.has(messageId) ||
      (pb.hoveredTargetId === messageId) !== (nb.hoveredTargetId === messageId)
    ) {
      return false
    }
  }
  return true
}

function delegationPatchEqual(
  a: DelegationStatusChangedEventPayload | undefined,
  b: DelegationStatusChangedEventPayload | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.status === b.status &&
    a.claimedByLabel === b.claimedByLabel &&
    a.resultMessageId === b.resultMessageId &&
    a.statusNote === b.statusNote
  )
}

function botAccessPatchEqual(
  a: BotAccessStatusChangedEventPayload | undefined,
  b: BotAccessStatusChangedEventPayload | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.status === b.status
}

/**
 * Memoized timeline row. The timeline's inputs churn identity constantly
 * (Dexie liveQuery re-emits all-new arrays on any events write; ctx is
 * rebuilt per tick), so the memo uses a per-item comparator instead of
 * shallow props equality — a data tick re-renders only the rows whose own
 * inputs changed instead of the full window.
 */
export const TimelineItemContent = memo(TimelineItemContentImpl, timelineRowPropsEqual)

/**
 * Non-virtualized event list for threads and other cases where all items are rendered.
 * For virtualized streams/channels, use `<Virtuoso>` directly with `TimelineItemContent`.
 */
export function EventList({
  timelineItems,
  isLoading,
  workspaceId,
  streamId,
  highlightMessageId,
  firstUnreadEventId,
  isDividerDimmed,
  agentActivity,
  hideSessionCards,
  newMessageIds,
  viewerIsMember,
  batch,
  conversationOverlay,
}: EventListProps) {
  const { phase } = useCoordinatedLoading()
  const socket = useSocket()
  const stopAgentSession = useStopAgentSession(socket, workspaceId, streamId)
  const steerAgentSession = useSteerAgentSession(workspaceId, streamId)

  const { sessionLiveCounts, sessionLiveSubsteps } = useMemo(() => {
    const counts = new Map<string, { stepCount: number; messageCount: number }>()
    const substeps = new Map<string, string | null>()
    if (agentActivity) {
      for (const activity of agentActivity.values()) {
        counts.set(activity.sessionId, {
          stepCount: activity.stepCount,
          messageCount: activity.messageCount,
        })
        substeps.set(activity.sessionId, activity.substep)
      }
    }
    return { sessionLiveCounts: counts, sessionLiveSubsteps: substeps }
  }, [agentActivity])

  const handleStopSession = useMemo(() => (sessionId: string) => stopAgentSession(sessionId), [stopAgentSession])

  // Day boundaries between rows from different local days (INV-42). Threads
  // render all events with no zero-height filtering, so dividers go straight
  // onto the grouped list.
  const itemsWithDividers = useMemo(() => injectDayDividers(timelineItems), [timelineItems])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 px-4 py-6 sm:px-6">
        <div className="flex gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </div>
      </div>
    )
  }

  // First-message lookup for the context-bag attachment badge. We render the
  // chip on whichever message sits at the top of the stream (smallest
  // sequence) so it visually anchors the conversation's source — matches the
  // file-attachment UX where uploads on the composer "move" onto the message
  // at send. `timelineItems` is already in render order (oldest first).
  const firstMessageId = findFirstMessageId(timelineItems)
  const cancelledFollowUpIds = collectCancelledFollowUpIds(timelineItems)
  const delegationStatusPatches = collectDelegationStatusPatches(timelineItems)
  const botAccessStatusPatches = collectBotAccessStatusPatches(timelineItems)

  if (timelineItems.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">No messages yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Start the conversation by sending a message below</p>
        </div>
      </div>
    )
  }

  const ctx: TimelineItemRenderContext = {
    workspaceId,
    streamId,
    highlightMessageId,
    firstUnreadEventId,
    isDividerDimmed,
    agentActivity,
    hideSessionCards,
    newMessageIds,
    firstMessageId,
    sessionLiveCounts,
    sessionLiveSubsteps,
    onStopSession: handleStopSession,
    onSteerSession: steerAgentSession,
    cancelledFollowUpIds,
    delegationStatusPatches,
    botAccessStatusPatches,
    viewerIsMember,
    batch,
    conversationOverlay,
  }

  return (
    <div className="flex flex-col py-3 sm:py-6 mx-auto max-w-[800px] w-full min-w-0">
      {itemsWithDividers.map((item) => {
        const itemKey = getTimelineItemKey(item)
        return (
          <div key={itemKey} className={isFirstUnread(item, firstUnreadEventId) ? "relative" : undefined}>
            <TimelineItemContent item={item} ctx={ctx} deferSecondaryHydration={phase !== "ready"} />
          </div>
        )
      })}
    </div>
  )
}
