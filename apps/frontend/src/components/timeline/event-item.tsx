import type { StreamEvent } from "@threa/types"
import type { MessageAgentActivity } from "@/hooks"
import type { BatchTimelineState } from "./event-list"
import { MessageEvent } from "./message-event"
import { MembershipEvent } from "./membership-event"
import { MessagesMovedEvent } from "./messages-moved-event"
import { MemoCapturedEvent } from "./memo-captured-event"
import { SystemEvent } from "./system-event"

interface EventItemProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  /** This message is the thread parent shown at the top of the thread panel */
  isThreadParent?: boolean
  /** ID of message to highlight and scroll to */
  highlightMessageId?: string | null
  /** Active agent sessions mapped by trigger message ID */
  agentActivity?: Map<string, MessageAgentActivity>
  /** Whether this event just arrived via socket (brief visual indicator) */
  isNew?: boolean
  /** Defer non-critical per-message hydration until coordinated reveal completes */
  deferSecondaryHydration?: boolean
  /**
   * True when this event is a continuation of a same-author run (messages 2..N
   * within 5 min). Message renderer collapses the header row and shows only a
   * gutter time stamp. Runtime state (pending/failed/editing) may still force
   * a full header in MessageEvent regardless.
   */
  groupContinuation?: boolean
  /**
   * True when this event renders the first message in the stream. Drives the
   * `<MessageContextBadge>` attachment-style chip on bag-attached scratchpads
   * — only the opening message gets the breadcrumb.
   */
  isFirstMessage?: boolean
  batch?: BatchTimelineState
}

export function EventItem({
  event,
  workspaceId,
  streamId,
  isThreadParent,
  highlightMessageId,
  agentActivity,
  isNew,
  deferSecondaryHydration = false,
  groupContinuation = false,
  isFirstMessage = false,
  batch,
}: EventItemProps) {
  // Check if this event's message should be highlighted
  const messageId = (event.payload as { messageId?: string })?.messageId
  const isHighlighted = highlightMessageId != null && messageId === highlightMessageId

  switch (event.eventType) {
    case "message_created":
    case "companion_response": {
      const payload = event.payload as { deletedAt?: string }
      if (payload.deletedAt) {
        return (
          <div data-event-id={event.id}>
            <DeletedMessageEvent event={event} />
          </div>
        )
      }
      return (
        <div data-event-id={event.id} data-message-id={messageId}>
          <MessageEvent
            event={event}
            workspaceId={workspaceId}
            streamId={streamId}
            isThreadParent={isThreadParent}
            isHighlighted={isHighlighted}
            isNew={isNew}
            activity={messageId ? agentActivity?.get(messageId) : undefined}
            deferSecondaryHydration={deferSecondaryHydration}
            groupContinuation={groupContinuation}
            isFirstMessage={isFirstMessage}
            batch={batch}
          />
        </div>
      )
    }

    case "message_deleted":
      return (
        <div data-event-id={event.id}>
          <DeletedMessageEvent event={event} />
        </div>
      )

    case "member_joined":
    case "member_added":
    case "member_left":
      return (
        <div data-event-id={event.id}>
          <MembershipEvent event={event} workspaceId={workspaceId} />
        </div>
      )

    case "thread_created":
      return (
        <div data-event-id={event.id}>
          <SystemEvent event={event} />
        </div>
      )

    case "messages:moved": {
      // Destination-side rows render no inline tombstone — the destination
      // already shows the moved messages themselves, plus a per-message
      // origin badge + "Show move details" context-menu entry. Short-
      // circuiting here (rather than inside `MessagesMovedEvent`) avoids
      // mounting the component at all on destination rows, so the
      // tombstone's `useActors` subscription only runs where it's used.
      const movedPayload = event.payload as { destinationStreamId?: string }
      if (movedPayload.destinationStreamId === streamId) return null
      return (
        <div data-event-id={event.id}>
          <MessagesMovedEvent event={event} workspaceId={workspaceId} />
        </div>
      )
    }

    case "memos:captured":
      return (
        <div data-event-id={event.id}>
          <MemoCapturedEvent event={event} workspaceId={workspaceId} />
        </div>
      )

    case "reaction_added":
    case "reaction_removed":
      // Reactions update the parent message in place, not rendered as separate items
      return null

    case "command_dispatched":
    case "command_completed":
    case "command_failed":
      // Command events are grouped and rendered in EventList, not here
      return null

    case "agent_session:started":
    case "agent_session:completed":
    case "agent_session:failed":
    case "agent_session:deleted":
      // Agent session events are grouped and rendered in EventList, not here
      return null

    default:
      // Unknown event type - render as system event
      return (
        <div data-event-id={event.id}>
          <SystemEvent event={event} />
        </div>
      )
  }
}

function DeletedMessageEvent(_props: { event: StreamEvent }) {
  return (
    <div className="py-0.5 px-3 sm:px-6 text-center">
      <p className="text-xs italic text-muted-foreground">This message was deleted</p>
    </div>
  )
}
