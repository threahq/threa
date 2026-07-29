import { STREAM_ROW_SPEC, type DelegationStatusChangedEventPayload, type MemosCapturedEventPayload } from "@threa/types"
import type { CachedEvent } from "@/db"
import { getSessionId, getSessionSlotKey, getTriggerMessageId } from "@/components/timeline/session-grouping"

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
  | {
      kind: "delegation"
      key: string
      sortMs: number
      streamId: string
      event: CachedEvent
      statusPatch?: DelegationStatusChangedEventPayload
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
 * - `agent:follow_up_cancelled` is a patch, not a row: it flips the matching
 *   scheduled card's `cancelled` flag (mirrors the timeline's cancel handling).
 * - `delegation:status_changed` is likewise a patch: the latest one per
 *   delegation rides on the delegation row as `statusPatch`.
 */
export function resolveBoardEventRows(events: CachedEvent[], ctx: ResolveBoardEventRowsCtx): BoardEventRow[] {
  const cancelledFollowUpIds = new Set<string>()
  const delegationStatusPatches = new Map<string, { payload: DelegationStatusChangedEventPayload; atMs: number }>()
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
    }
  }

  const sessions = new Map<string, { events: CachedEvent[]; trigger: string | null }>()
  const rows: BoardEventRow[] = []

  for (const event of events) {
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

  rows.sort((a, b) => a.sortMs - b.sortMs)
  return rows
}
