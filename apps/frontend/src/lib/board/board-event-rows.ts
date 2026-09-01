import {
  STREAM_ROW_SPEC,
  type AsideAnchoredEventPayload,
  type DelegationStatusChangedEventPayload,
  type MemosCapturedEventPayload,
  type SubagentStatusChangedEventPayload,
} from "@threa/types"
import type { CachedEvent } from "@/db"
import { getSessionId, getSessionSlotKey, getTriggerMessageId } from "@/components/timeline/session-grouping"
import { getCommandId, isOwnCommandEvent } from "@/components/timeline/command-grouping"

/**
 * A non-message stream event, resolved to the conversation it should draw on for
 * the board card / conversation panel. Agent-session lifecycle events are grouped
 * into one `session` row (start + complete/failed/deleted), matching the timeline;
 * memo captures, scheduled follow-ups and delegations are single rows. Every kind is
 * render-only — none is a conversation member and none bumps activity (INV: the
 * `bumps: false` contract in STREAM_ROW_SPEC).
 */
export type BoardEventRow =
  | { kind: "session"; key: string; sortMs: number; streamId: string; events: CachedEvent[] }
  | { kind: "memo"; key: string; sortMs: number; streamId: string; event: CachedEvent }
  | { kind: "followUp"; key: string; sortMs: number; streamId: string; event: CachedEvent; cancelled: boolean }
  | { kind: "command"; key: string; sortMs: number; streamId: string; events: CachedEvent[] }
  | { kind: "aside"; key: string; sortMs: number; streamId: string; event: CachedEvent }
  | {
      kind: "delegation"
      key: string
      sortMs: number
      streamId: string
      event: CachedEvent
      statusPatch?: DelegationStatusChangedEventPayload
    }
  | {
      kind: "subagent"
      key: string
      sortMs: number
      streamId: string
      event: CachedEvent
      statusPatch?: CachedEvent
    }

export interface ResolveBoardEventRowsCtx {
  /** The conversation the card renders. */
  conversationId: string
  /**
   * The conversation's member message ids (opening + replies + server
   * `messageIds`). An agent session belongs here iff its invoking message is one
   * of these — the same "trigger message is a conversation member" rule the board
   * design specifies for showing traces without new delivery.
   */
  memberMessageIds: Set<string>
  /**
   * Whose commands the card may draw. Command events are stream-scoped over the
   * socket, so without this every member's IDB would render everyone's
   * invocations — the same author rule the timeline applies.
   */
  currentUserId?: string | null
  /**
   * Asides that are archived draw no row, folded or full — the anchor row's
   * own rule (`AsideAnchorEvent` renders nothing for an archived aside). The
   * card resolves this from the stream cache; absent, no aside row is dropped.
   */
  archivedAsideIds?: ReadonlySet<string>
}

function timeMs(event: CachedEvent): number {
  return new Date(event.createdAt).getTime()
}

/**
 * Resolve the spec-eligible non-message events on a card's stream rail into the
 * ordered, conversation-scoped rows the board draws. Pure over its inputs so the
 * placement rules are unit-testable in isolation.
 *
 * - `source-conversation` rows (memos:captured, follow-ups, delegations) match on
 *   the conversation id their payload names.
 * - `trigger-message` rows (agent sessions) are grouped by session id; the group
 *   shows iff the session's `started` event names a trigger that is a member.
 * - command events are grouped by `commandId` into one chip row, author-scoped,
 *   placed on the conversation the dispatch names (a stream-level dispatch names
 *   none and draws nowhere).
 * - `aside:anchored` is a single author-scoped row placed on the conversation
 *   its payload names (a message-anchored aside names none and draws nowhere).
 * - `agent:follow_up_cancelled` is a patch, not a row: it flips the matching
 *   scheduled card's `cancelled` flag (mirrors the timeline's cancel handling).
 * - `delegation:status_changed` is likewise a patch: the latest one per
 *   delegation rides on the delegation row as `statusPatch`.
 */
export function resolveBoardEventRows(events: CachedEvent[], ctx: ResolveBoardEventRowsCtx): BoardEventRow[] {
  const cancelledFollowUpIds = new Set<string>()
  const delegationStatusPatches = new Map<string, { payload: DelegationStatusChangedEventPayload; atMs: number }>()
  const subagentStatusPatches = new Map<string, { event: CachedEvent; atMs: number }>()
  for (const event of events) {
    if (event.eventType === "agent:follow_up_cancelled") {
      const followUpId = (event.payload as { followUpId?: string })?.followUpId
      if (followUpId) cancelledFollowUpIds.add(followUpId)
      continue
    }
    if (event.eventType === "delegation:status_changed") {
      const payload = event.payload as DelegationStatusChangedEventPayload | undefined
      if (!payload?.delegationId) continue
      const atMs = timeMs(event)
      const existing = delegationStatusPatches.get(payload.delegationId)
      if (!existing || atMs >= existing.atMs) delegationStatusPatches.set(payload.delegationId, { payload, atMs })
      continue
    }
    if (event.eventType === "subagent:status_changed") {
      const subagentId = (event.payload as SubagentStatusChangedEventPayload | undefined)?.subagentId
      if (!subagentId) continue
      const atMs = timeMs(event)
      const existing = subagentStatusPatches.get(subagentId)
      // The whole event, not just the payload: the card's meta line reports who
      // ended the run and when, and only the event row carries actor and time.
      if (!existing || atMs >= existing.atMs) subagentStatusPatches.set(subagentId, { event, atMs })
    }
  }

  const sessions = new Map<string, { events: CachedEvent[]; trigger: string | null }>()
  const commands = new Map<
    string,
    { events: CachedEvent[]; dispatched: CachedEvent | null; conversation: string | null }
  >()
  const rows: BoardEventRow[] = []

  for (const event of events) {
    if (STREAM_ROW_SPEC[event.eventType].grouping === "command") {
      const commandId = getCommandId(event)
      if (!commandId) continue
      if (!isOwnCommandEvent(event, ctx.currentUserId)) continue
      let command = commands.get(commandId)
      if (!command) {
        command = { events: [], dispatched: null, conversation: null }
        commands.set(commandId, command)
      }
      command.events.push(event)
      if (event.eventType === "command_dispatched") {
        command.dispatched = event
        command.conversation = (event.payload as { conversationId?: string })?.conversationId ?? null
      }
      continue
    }
    if (event.eventType === "aside:anchored") {
      const payload = event.payload as AsideAnchoredEventPayload | undefined
      if (payload?.conversationId !== ctx.conversationId) continue
      if (!isOwnCommandEvent(event, ctx.currentUserId)) continue
      if (payload?.asideId && ctx.archivedAsideIds?.has(payload.asideId)) continue
      rows.push({ kind: "aside", key: event.id, sortMs: timeMs(event), streamId: event.streamId, event })
      continue
    }
    const ref = STREAM_ROW_SPEC[event.eventType].conversationRef
    if (ref === "trigger-message") {
      const sessionId = getSessionId(event)
      if (!sessionId) continue
      let session = sessions.get(sessionId)
      if (!session) {
        session = { events: [], trigger: null }
        sessions.set(sessionId, session)
      }
      session.events.push(event)
      const trigger = getTriggerMessageId(event)
      if (trigger) session.trigger = trigger
    } else if (ref === "source-conversation") {
      const payload = event.payload as { conversationId?: string; sourceConversationId?: string }
      const target = payload?.conversationId ?? payload?.sourceConversationId ?? null
      if (event.eventType === "memos:captured" && target === null) {
        // A memo saved before its source message was assigned to a conversation
        // carries no conversation id, and the event payload is immutable — placing
        // it by provenance is the only way it ever lands. Same rule the session rows
        // use, so it stays a single membership test.
        const memos = (event.payload as MemosCapturedEventPayload | undefined)?.memos ?? []
        const belongs = memos.some((memo) =>
          memo.sourceMessageIds.some((messageId) => ctx.memberMessageIds.has(messageId))
        )
        if (!belongs) continue
        rows.push({ kind: "memo", key: event.id, sortMs: timeMs(event), streamId: event.streamId, event })
        continue
      }
      if (target !== ctx.conversationId) continue
      if (event.eventType === "memos:captured") {
        rows.push({ kind: "memo", key: event.id, sortMs: timeMs(event), streamId: event.streamId, event })
      } else if (event.eventType === "agent:follow_up_scheduled") {
        const followUpId = (event.payload as { followUpId?: string })?.followUpId
        rows.push({
          kind: "followUp",
          key: event.id,
          sortMs: timeMs(event),
          streamId: event.streamId,
          event,
          cancelled: followUpId ? cancelledFollowUpIds.has(followUpId) : false,
        })
      } else if (event.eventType === "delegation:created") {
        const delegationId = (event.payload as { delegationId?: string })?.delegationId
        rows.push({
          kind: "delegation",
          key: event.id,
          sortMs: timeMs(event),
          streamId: event.streamId,
          event,
          statusPatch: delegationId ? delegationStatusPatches.get(delegationId)?.payload : undefined,
        })
      } else if (event.eventType === "subagent:created") {
        const subagentId = (event.payload as { subagentId?: string })?.subagentId
        rows.push({
          kind: "subagent",
          key: event.id,
          sortMs: timeMs(event),
          streamId: event.streamId,
          event,
          statusPatch: subagentId ? subagentStatusPatches.get(subagentId)?.event : undefined,
        })
      }
    }
  }

  // Collapse sessions that share a trigger slot to the latest one, mirroring the
  // timeline's `groupTimelineItems` (event-list.tsx). A re-run after an
  // invoking-message edit supersedes the old session — SAME triggerMessageId, NEW
  // sessionId, no `agent_session:deleted` tombstone — so keying by raw sessionId
  // would leave the old completed trace on the card as a duplicate that the
  // timeline hides. Keyed by slot (trigger), newest-started wins; the row key is
  // the slot, so a re-run updates the card in place.
  const bySlot = new Map<string, { events: CachedEvent[]; startMs: number }>()
  for (const [sessionId, session] of sessions) {
    if (!session.trigger || !ctx.memberMessageIds.has(session.trigger)) continue
    const ordered = [...session.events].sort((a, b) => timeMs(a) - timeMs(b))
    const started = ordered.find((event) => event.eventType === "agent_session:started")
    const startMs = started ? timeMs(started) : timeMs(ordered[0])
    const slotKey = getSessionSlotKey(sessionId, session.trigger)
    const existing = bySlot.get(slotKey)
    if (!existing || startMs > existing.startMs) bySlot.set(slotKey, { events: ordered, startMs })
  }
  for (const [slotKey, slot] of bySlot) {
    rows.push({
      kind: "session",
      key: slotKey,
      sortMs: timeMs(slot.events[0]),
      streamId: slot.events[0].streamId,
      events: slot.events,
    })
  }

  // A command lands on the card its dispatch names. `command_completed` /
  // `command_failed` carry no conversation at all — they reach the row through
  // the group's `commandId`, which is why the group, not the event, is placed.
  for (const [commandId, command] of commands) {
    if (!command.dispatched || command.conversation !== ctx.conversationId) continue
    const ordered = [...command.events].sort((a, b) => timeMs(a) - timeMs(b))
    rows.push({
      kind: "command",
      key: commandId,
      sortMs: timeMs(command.dispatched),
      streamId: command.dispatched.streamId,
      events: ordered,
    })
  }

  rows.sort((a, b) => a.sortMs - b.sortMs)
  return rows
}
