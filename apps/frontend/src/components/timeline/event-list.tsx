import { useMemo } from "react"
import {
  COMMAND_EVENT_TYPES,
  AGENT_SESSION_EVENT_TYPES,
  AgentStepTypes,
  type CommandEventType,
  type AgentSessionEventType,
  type AgentSessionStartedPayload,
  type StreamEvent,
  type CommandDispatchedPayload,
  type CommandCompletedPayload,
  type CommandFailedPayload,
} from "@threa/types"
import type { MessageAgentActivity } from "@/hooks"
import { useSocket, useCoordinatedLoading } from "@/contexts"
import { useAbortResearch } from "@/hooks"
import { EventItem } from "./event-item"
import { AgentSessionEvent } from "./agent-session-event"
import { CommandEvent } from "./command-event"
import { UnreadDivider } from "./unread-divider"
import { Skeleton } from "@/components/ui/skeleton"

interface EventListProps {
  timelineItems: TimelineItem[]
  isLoading: boolean
  workspaceId: string
  streamId: string
  highlightMessageId?: string | null
  firstUnreadEventId?: string
  isDividerFading?: boolean
  agentActivity?: Map<string, MessageAgentActivity>
  /** Hide session group cards (used in channels where responses go to threads) */
  hideSessionCards?: boolean
  /** Event IDs that just arrived via socket and should flash briefly */
  newMessageIds?: Set<string>
  batch?: BatchTimelineState
}

/**
 * Shared batch-selection state passed from `StreamContent` into timeline rows.
 * Enabled rows render selection controls and expose drag/drop target feedback.
 */
export interface BatchTimelineState {
  /** Whether batch-selection mode is active. */
  enabled: boolean
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

function isAgentSessionEvent(event: StreamEvent): boolean {
  return AGENT_SESSION_EVENT_TYPES.includes(event.eventType as AgentSessionEventType)
}

function getSessionId(event: StreamEvent): string | null {
  if (!isAgentSessionEvent(event)) return null
  return (event.payload as { sessionId?: string })?.sessionId ?? null
}

function getTriggerMessageId(event: StreamEvent): string | null {
  if (event.eventType !== "agent_session:started") return null
  return (event.payload as AgentSessionStartedPayload).triggerMessageId ?? null
}

function getSessionSlotKey(sessionId: string, triggerMessageId: string | null): string {
  return triggerMessageId ? `trigger:${triggerMessageId}` : `session:${sessionId}`
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
    }
  | { type: "command_group"; commandId: string; events: StreamEvent[] }
  | { type: "session_group"; sessionId: string; sessionVersion: number; events: StreamEvent[] }

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
  "agent_session:deleted",
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
  return items.findIndex(
    (item) => item.type === "event" && (item.event.payload as { messageId?: string })?.messageId === messageId
  )
}

/** Returns a stable key string for a timeline item */
export function getTimelineItemKey(item: TimelineItem): string {
  switch (item.type) {
    case "command_group":
      return item.commandId
    case "session_group":
      return item.sessionId
    default:
      return item.event.id
  }
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
  isDividerFading?: boolean
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
  /** Whether the session's current step is one we can graceful-abort. */
  sessionCanAbort: Map<string, boolean>
  /** Click handler for the Stop research button. */
  onAbortResearch?: (sessionId: string) => void
  phase: string
  batch?: BatchTimelineState
}

function isFirstUnread(item: TimelineItem, firstUnreadEventId?: string): boolean {
  if (!firstUnreadEventId) return false
  if (item.type === "command_group" || item.type === "session_group") {
    return item.events[0]?.id === firstUnreadEventId
  }
  return item.event.id === firstUnreadEventId
}

/** Renders a single timeline item. Used by Virtuoso's itemContent and non-virtualized lists. */
export function TimelineItemContent({ item, ctx }: { item: TimelineItem; ctx: TimelineItemRenderContext }) {
  const showUnreadDivider = isFirstUnread(item, ctx.firstUnreadEventId)
  return (
    <>
      {showUnreadDivider && <UnreadDivider isFading={ctx.isDividerFading} />}
      {item.type === "command_group" && (
        <div className="px-3 sm:px-6">
          <CommandEvent events={item.events} />
        </div>
      )}
      {item.type === "session_group" && !ctx.hideSessionCards && (
        <div className="px-3 sm:px-6">
          <AgentSessionEvent
            events={item.events}
            sessionVersion={item.sessionVersion}
            liveCounts={ctx.sessionLiveCounts.get(item.sessionId)}
            liveSubstep={ctx.sessionLiveSubsteps.get(item.sessionId)}
            canAbortResearch={ctx.sessionCanAbort.get(item.sessionId) ?? false}
            onAbortResearch={ctx.onAbortResearch}
          />
        </div>
      )}
      {item.type === "event" && (
        <EventItem
          event={item.event}
          workspaceId={ctx.workspaceId}
          streamId={ctx.streamId}
          highlightMessageId={ctx.highlightMessageId}
          agentActivity={ctx.hideSessionCards ? ctx.agentActivity : undefined}
          isNew={ctx.newMessageIds?.has(item.event.id)}
          deferSecondaryHydration={ctx.phase !== "ready"}
          batch={ctx.batch}
          // Continuations directly under an UnreadDivider promote back to head so
          // the first unread message in a run still reads as a fresh turn for the
          // viewer (fixes the "continuation starting an unread block" edge case).
          groupContinuation={item.groupContinuation && !showUnreadDivider}
          isFirstMessage={
            ctx.firstMessageId != null &&
            (item.event.payload as { messageId?: string })?.messageId === ctx.firstMessageId
          }
        />
      )}
    </>
  )
}

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
  isDividerFading,
  agentActivity,
  hideSessionCards,
  newMessageIds,
  batch,
}: EventListProps) {
  const { phase } = useCoordinatedLoading()
  const socket = useSocket()
  const abortResearch = useAbortResearch(socket)

  const { sessionLiveCounts, sessionLiveSubsteps, sessionCanAbort } = useMemo(() => {
    const counts = new Map<string, { stepCount: number; messageCount: number }>()
    const substeps = new Map<string, string | null>()
    const canAbort = new Map<string, boolean>()
    if (agentActivity) {
      for (const activity of agentActivity.values()) {
        counts.set(activity.sessionId, {
          stepCount: activity.stepCount,
          messageCount: activity.messageCount,
        })
        substeps.set(activity.sessionId, activity.substep)
        // V1: only workspace_search supports graceful abort. The registry is generic
        // so other tools can opt in by adding their step type here.
        canAbort.set(activity.sessionId, activity.currentStepType === AgentStepTypes.WORKSPACE_SEARCH)
      }
    }
    return { sessionLiveCounts: counts, sessionLiveSubsteps: substeps, sessionCanAbort: canAbort }
  }, [agentActivity])

  const handleAbortResearch = useMemo(
    () => (sessionId: string) => abortResearch({ sessionId, workspaceId }),
    [abortResearch, workspaceId]
  )

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
    isDividerFading,
    agentActivity,
    hideSessionCards,
    newMessageIds,
    firstMessageId,
    sessionLiveCounts,
    sessionLiveSubsteps,
    sessionCanAbort,
    onAbortResearch: handleAbortResearch,
    phase,
    batch,
  }

  return (
    <div className="flex flex-col py-3 sm:py-6 mx-auto max-w-[800px] w-full min-w-0">
      {timelineItems.map((item) => {
        const itemKey = getTimelineItemKey(item)
        return (
          <div key={itemKey} className={isFirstUnread(item, firstUnreadEventId) ? "relative" : undefined}>
            <TimelineItemContent item={item} ctx={ctx} />
          </div>
        )
      })}
    </div>
  )
}
