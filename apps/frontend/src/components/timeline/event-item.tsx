import type {
  BotAccessStatusChangedEventPayload,
  CallEndedEventPayload,
  DelegationStatusChangedEventPayload,
  StreamEvent,
} from "@threa/types"
import type { MessageAgentActivity } from "@/hooks"
import type { BatchTimelineState } from "./event-list"
import type { ConversationRevival } from "./conversation-overlay/model"
import { MessageEvent } from "./message-event"
import { MembershipEvent } from "./membership-event"
import { MessagesMovedEvent } from "./messages-moved-event"
import { MemoCapturedEvent } from "./memo-captured-event"
import { FollowUpScheduledEvent } from "./follow-up-event"
import { DelegationEvent } from "./delegation-event"
import { BotAccessEvent } from "./bot-access-event"
import { BriefUpdatedEvent } from "./brief-updated-event"
import { DescriptionSetEvent } from "./description-set-event"
import { CallCard } from "./call-card"
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
  /** followUpIds cancelled within the loaded window — drives the scheduled card's cancelled state. */
  cancelledFollowUpIds?: Set<string>
  /** Latest status patch per delegationId within the loaded window — drives the delegation card's state. */
  delegationStatusPatches?: Map<string, DelegationStatusChangedEventPayload>
  /** Latest status patch per bot-access requestId within the loaded window — drives the request card's state. */
  botAccessStatusPatches?: Map<string, BotAccessStatusChangedEventPayload>
  /** Latest `call_ended` payload per callId within the loaded window — drives the call card's ended state. */
  callEndedPatches?: Map<string, CallEndedEventPayload>
  /** True when the viewer is a stream member — gates the request card's Approve/Deny buttons. */
  viewerIsMember?: boolean
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
  /**
   * Topic-revival annotation for the on-message provenance chip, when this
   * message reopens a scattered conversation (channel/DM timelines only).
   */
  revival?: ConversationRevival
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
  cancelledFollowUpIds,
  delegationStatusPatches,
  botAccessStatusPatches,
  callEndedPatches,
  viewerIsMember,
  deferSecondaryHydration = false,
  groupContinuation = false,
  isFirstMessage = false,
  revival,
  batch,
}: EventItemProps) {
  const messageId = (event.payload as { messageId?: string })?.messageId
  const isHighlighted = highlightMessageId != null && messageId === highlightMessageId
  // Cards deep-link by their event id (`?m=event_…`); they get the same flash the
  // message path applies, on the wrapper since card renderers own no ring slot.
  const cardHighlightClass =
    highlightMessageId != null && event.id === highlightMessageId ? "animate-highlight-flash" : undefined

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
            revival={revival}
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

    case "description_set":
      return (
        <div data-event-id={event.id}>
          <DescriptionSetEvent event={event} workspaceId={workspaceId} />
        </div>
      )

    case "thread_created":
    case "stream_archived":
    case "stream_unarchived":
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

    case "agent:follow_up_scheduled": {
      const followUpId = (event.payload as { followUpId?: string })?.followUpId
      const cancelledByEvent = followUpId ? (cancelledFollowUpIds?.has(followUpId) ?? false) : false
      return (
        <div data-event-id={event.id}>
          <FollowUpScheduledEvent event={event} workspaceId={workspaceId} cancelledByEvent={cancelledByEvent} />
        </div>
      )
    }

    case "brief_updated":
      return (
        <div data-event-id={event.id}>
          <BriefUpdatedEvent event={event} workspaceId={workspaceId} streamId={streamId} />
        </div>
      )

    case "delegation:created": {
      const delegationId = (event.payload as { delegationId?: string })?.delegationId
      const statusPatch = delegationId ? delegationStatusPatches?.get(delegationId) : undefined
      return (
        <div data-event-id={event.id} className={cardHighlightClass}>
          <DelegationEvent
            event={event}
            workspaceId={workspaceId}
            streamId={streamId}
            statusPatch={statusPatch}
            isThreadParent={isThreadParent}
          />
        </div>
      )
    }

    case "delegation:status_changed":
      // Patch, not a row: it advances the matching delegation card via
      // delegationStatusPatches (collected in event-list) — renders nothing.
      return null

    case "bot_access:requested": {
      const requestId = (event.payload as { requestId?: string })?.requestId
      const statusPatch = requestId ? botAccessStatusPatches?.get(requestId) : undefined
      return (
        <div data-event-id={event.id}>
          <BotAccessEvent
            event={event}
            workspaceId={workspaceId}
            statusPatch={statusPatch}
            viewerIsMember={viewerIsMember}
          />
        </div>
      )
    }

    case "bot_access:status_changed":
      // Patch, not a row: it resolves the matching request card via
      // botAccessStatusPatches (collected in event-list) — renders nothing.
      return null

    case "call_started": {
      const callId = (event.payload as { callId?: string })?.callId
      const endedPatch = callId ? callEndedPatches?.get(callId) : undefined
      return (
        <div data-event-id={event.id} className={cardHighlightClass}>
          <CallCard
            event={event}
            workspaceId={workspaceId}
            streamId={streamId}
            endedPatch={endedPatch}
            isThreadParent={isThreadParent}
          />
        </div>
      )
    }

    case "call_ended":
      // Patch, not a row: it carries the end summary onto the matching call card
      // via callEndedPatches (collected in event-list) — renders nothing itself.
      return null

    case "agent:follow_up_cancelled":
      // Patch, not a row: it flips the matching scheduled card to "Cancelled"
      // via cancelledFollowUpIds (collected in event-list), so it renders nothing
      // itself — avoids a redundant second row for the same cancellation.
      return null

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
    case "agent_session:interrupted":
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
