import { STREAM_ROW_SPEC } from "@threa/types"
import type { CachedEvent } from "@/db"
import { getSessionId, getTriggerMessageId } from "@/components/timeline/session-grouping"

/**
 * A non-message stream event, resolved to the conversation it should draw on for
 * the board card / conversation panel. Agent-session lifecycle events are grouped
 * into one `session` row (start + complete/failed/deleted), matching the timeline;
 * memo captures and scheduled follow-ups are single rows. Every kind is
 * render-only — none is a conversation member and none bumps activity (INV: the
 * `bumps: false` contract in STREAM_ROW_SPEC).
 */
export type BoardEventRow =
  | { kind: "session"; key: string; sortMs: number; streamId: string; events: CachedEvent[] }
  | { kind: "memo"; key: string; sortMs: number; streamId: string; event: CachedEvent }
  | { kind: "followUp"; key: string; sortMs: number; streamId: string; event: CachedEvent; cancelled: boolean }

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
 * - `source-conversation` rows (memos:captured, follow-ups) match on the
 *   conversation id their payload names.
 * - `trigger-message` rows (agent sessions) are grouped by session id; the group
 *   shows iff the session's `started` event names a trigger that is a member.
 * - `agent:follow_up_cancelled` is a patch, not a row: it flips the matching
 *   scheduled card's `cancelled` flag (mirrors the timeline's cancel handling).
 */
export function resolveBoardEventRows(events: CachedEvent[], ctx: ResolveBoardEventRowsCtx): BoardEventRow[] {
  const cancelledFollowUpIds = new Set<string>()
  for (const event of events) {
    if (event.eventType !== "agent:follow_up_cancelled") continue
    const followUpId = (event.payload as { followUpId?: string })?.followUpId
    if (followUpId) cancelledFollowUpIds.add(followUpId)
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
      }
    }
  }

  for (const [sessionId, session] of sessions) {
    if (!session.trigger || !ctx.memberMessageIds.has(session.trigger)) continue
    const ordered = [...session.events].sort((a, b) => timeMs(a) - timeMs(b))
    rows.push({
      kind: "session",
      key: `session:${sessionId}`,
      sortMs: timeMs(ordered[0]),
      streamId: ordered[0].streamId,
      events: ordered,
    })
  }

  rows.sort((a, b) => a.sortMs - b.sortMs)
  return rows
}
