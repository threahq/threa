import type { StreamEvent } from "@threa/types"
import { isContinuation, type RenderableMessage } from "@/components/message/message-item"
import { AgentSessionEvent } from "@/components/timeline/agent-session-event"
import { MemoCapturedEvent } from "@/components/timeline/memo-captured-event"
import { FollowUpScheduledEvent } from "@/components/timeline/follow-up-event"
import type { BoardEventRow } from "@/lib/board/board-event-rows"

/**
 * One row in a board card / conversation panel: either a member message (with its
 * same-author continuation flag) or an interleaved agent/memo/follow-up event row.
 * The board renders both through {@link buildBoardRows} so a conversation surface
 * is a second *view* of the stream's events, not a message-only parallel renderer.
 */
export type BoardRow =
  | { kind: "message"; key: string; message: RenderableMessage; continuation: boolean }
  | { kind: "event"; key: string; row: BoardEventRow }

/**
 * Interleave a chronological message list with the conversation's event rows by
 * time. Continuation grouping is preserved for messages and **broken by any
 * interleaved event row** (a session/memo/follow-up between two same-author
 * messages ends the run) — the board's analog of the timeline's
 * `annotateAuthorGroups` reset on a non-message item.
 *
 * `messages` is assumed already ordered as it should render (the caller's
 * opening + displayed replies). Event rows that sort *before* the first message
 * are dropped: on a collapsed card they belong to the hidden middle, and
 * expanding re-includes them once the opening leads the list. A running session
 * after the last message therefore lands at the tail — exactly where "the agent I
 * just triggered" should appear.
 */
export function buildBoardRows(messages: RenderableMessage[], eventRows: BoardEventRow[]): BoardRow[] {
  if (eventRows.length === 0) {
    let prev: RenderableMessage | null = null
    return messages.map((message) => {
      const continuation = prev != null && isContinuation(prev, message)
      prev = message
      return { kind: "message", key: message.id, message, continuation }
    })
  }

  const firstMs = messages.length > 0 ? new Date(messages[0].createdAt).getTime() : Number.NEGATIVE_INFINITY

  type Entry = { t: number; slot: number; message?: RenderableMessage; event?: BoardEventRow }
  const entries: Entry[] = []
  for (const message of messages) entries.push({ t: new Date(message.createdAt).getTime(), slot: 0, message })
  for (const event of eventRows) if (event.sortMs >= firstMs) entries.push({ t: event.sortMs, slot: 1, event })
  // Stable sort keeps input order within an equal (t, slot); `slot` places a
  // message before an event sharing its exact timestamp.
  entries.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.slot - b.slot))

  const rows: BoardRow[] = []
  let prev: RenderableMessage | null = null
  for (const entry of entries) {
    if (entry.message) {
      const continuation = prev != null && isContinuation(prev, entry.message)
      rows.push({ kind: "message", key: entry.message.id, message: entry.message, continuation })
      prev = entry.message
    } else if (entry.event) {
      rows.push({ kind: "event", key: entry.event.key, row: entry.event })
      prev = null
    }
  }
  return rows
}

/**
 * Renders a non-message board row, reusing the timeline's own row components so a
 * board trace/memo/follow-up is identical to its timeline counterpart. Message
 * rows stay with the surface's own renderer (they carry card-specific read-state
 * and action wiring), so this only handles the event kinds. A `CachedEvent` is a
 * structural superset of `StreamEvent`, so the rail rows pass straight through.
 */
export function BoardEventRowItem({ row, workspaceId }: { row: BoardEventRow; workspaceId: string }) {
  switch (row.kind) {
    case "session":
      return (
        <div className="px-3 sm:px-4">
          <AgentSessionEvent events={row.events as StreamEvent[]} />
        </div>
      )
    case "memo":
      return <MemoCapturedEvent event={row.event as StreamEvent} workspaceId={workspaceId} />
    case "followUp":
      return (
        <FollowUpScheduledEvent
          event={row.event as StreamEvent}
          workspaceId={workspaceId}
          cancelledByEvent={row.cancelled}
        />
      )
  }
}
