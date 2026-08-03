import { useState, type ReactNode } from "react"
import { Bot, Clock, Sparkles, SquareSlash, TerminalSquare } from "lucide-react"
import type { StreamEvent } from "@threa/types"
import { useSteerAgentSession, useStopAgentSession } from "@/hooks"
import { isContinuation } from "@/lib/message-grouping"
import { type RenderableMessage } from "@/components/message/message-item"
import { AgentSessionEvent } from "@/components/timeline/agent-session-event"
import { MemoCapturedEvent } from "@/components/timeline/memo-captured-event"
import { MemoPreviewDialog } from "@/components/memo/memo-preview-dialog"
import { FollowUpScheduledEvent } from "@/components/timeline/follow-up-event"
import { DelegationEvent } from "@/components/timeline/delegation-event"
import { CommandEvent } from "@/components/timeline/command-event"
import { getSessionId } from "@/components/timeline/session-grouping"
import { useSocket, useTrace } from "@/contexts"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useAgentActivity, type MessageAgentActivity } from "@/hooks/use-agent-activity"
import { LedgerEventGroup, LedgerEventRow, type LedgerEventDescriptor } from "@/components/board/ledger-row"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { coalesceLedgerItems, ledgerEventContent, type LedgerItemKind } from "@/lib/board/ledger"
import type { BranchGrouping, BranchNode, BranchConversationView } from "@/lib/board/branch-grouping"
import { localStartOfDayMs } from "@/lib/dates"

/**
 * One row in a board card / conversation panel: a member message (with its
 * same-author continuation flag), an interleaved agent/memo/follow-up event row,
 * or one of the branch chrome rows (a soft-thread seam, a nested branch
 * conversation group, a spanning-overflow "continue thread" link). The board
 * renders all through {@link buildBoardRows} / {@link buildBranchedBoardRows} so a
 * conversation surface is a second *view* of the stream's events, not a parallel
 * renderer.
 *
 * `displayDepth` is the row's indent level (0–2); absent on the flat
 * {@link buildBoardRows} output, which never indents.
 */
export type BoardRow =
  | { kind: "message"; key: string; message: RenderableMessage; continuation: boolean; displayDepth?: number }
  | { kind: "event"; key: string; row: BoardEventRow; displayDepth?: number }
  | { kind: "ledger-event"; key: string; row: BoardEventRow; displayDepth?: number }
  | { kind: "ledger-event-group"; key: string; rows: BoardEventRow[]; displayDepth?: number }
  | { kind: "seam"; key: string; streamId: string; direction: "down" | "up"; displayDepth?: number }
  | { kind: "branch-group"; key: string; branch: BranchConversationView; displayDepth?: number }
  | { kind: "continue-thread"; key: string; streamId: string; hiddenCount: number; displayDepth?: number }
  | { kind: "day"; key: string; dayStartMs: number; displayDepth?: number }
  | { kind: "unread"; key: "unread"; isDimmed?: boolean; displayDepth?: number }

function rowDayStartMs(row: BoardRow): number | null {
  // Only depth-0 rows are globally time-sorted; indented thread runs are spliced
  // in beside their fork point, so letting them open a day would emit
  // out-of-order and duplicate-keyed dividers.
  if ((row.displayDepth ?? 0) !== 0) return null
  switch (row.kind) {
    case "message":
      return localStartOfDayMs(new Date(row.message.createdAt))
    case "event":
      return localStartOfDayMs(new Date(row.row.sortMs))
    case "day":
      return row.dayStartMs
    default:
      return null
  }
}

/**
 * Insert a `day` row before the first row of each local calendar day (INV-42),
 * the same rule `injectDayDividers` applies to the timeline: rows carrying no
 * timestamp (`seam`, `branch-group`, `continue-thread`) pass through without
 * opening or resetting the current day, and no divider is ever emitted above
 * the first timestamped row. Pure, and injected at the conversation-panel call
 * site only — a collapsed board card is a digest, not a timeline.
 */
export function injectBoardDayDividers(rows: BoardRow[]): BoardRow[] {
  const result: BoardRow[] = []
  let currentDayMs: number | null = null
  for (const row of rows) {
    const dayMs = rowDayStartMs(row)
    if (dayMs !== null) {
      if (currentDayMs !== null && dayMs !== currentDayMs) {
        result.push({ kind: "day", key: `day:${dayMs}`, dayStartMs: dayMs })
      }
      currentDayMs = dayMs
    }
    result.push(row)
  }
  return result
}

/**
 * Insert the single "New" divider row immediately before the marker's message
 * row — after {@link injectBoardDayDividers}, so a marker that opens a new day
 * reads `[day chip][New][message]`: the day labels the boundary, the New line
 * stays adjacent to the row it overlays. Pure; no-op when there is no marker or
 * its row is not in the list.
 */
export function injectUnreadDivider(rows: BoardRow[], markerMessageId: string | null, isDimmed = false): BoardRow[] {
  if (!markerMessageId) return rows
  const index = rows.findIndex((row) => row.kind === "message" && row.message.id === markerMessageId)
  if (index < 0) return rows
  const result = rows.slice()
  result.splice(index, 0, { kind: "unread", key: "unread", isDimmed, displayDepth: rows[index].displayDepth })
  return result
}

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
 * Fold the event rows of the card's LEDGER region into hair-thin ledger lines,
 * coalescing adjacent runs of two or more into one expandable group
 * (`coalesceLedgerItems`). The region ends at the first full-tail message row —
 * below it the reader is in full-detail mode, so those events keep their full
 * rendering (session cards, delegation cards).
 *
 * Runs are cut at every indent change, so a spanning thread's event never
 * coalesces with a base-level one. Events above the card's window are not
 * represented at all: they are render-only (`bumps: false`) and the head row
 * counts messages, so folding them into it would inflate a message count.
 */
export function foldLedgerEventRows(rows: BoardRow[], fullTailStartMessageId: string | null): BoardRow[] {
  const boundary = rows.findIndex((row) => row.kind === "message" && row.message.id === fullTailStartMessageId)
  const end = boundary < 0 ? rows.length : boundary
  if (end === 0) return rows

  const out: BoardRow[] = []
  let segment: BoardRow[] = []
  let segmentDepth: number | null = null

  const flush = () => {
    if (segment.length === 0) return
    const depth = segmentDepth ?? 0
    for (const item of coalesceLedgerItems(segment.map(ledgerItem))) {
      if (item.kind === "event-group") {
        out.push({
          kind: "ledger-event-group",
          key: `ledger-events:${item.events[0].source.key}`,
          rows: item.events.flatMap((event) => (event.row ? [event.row] : [])),
          displayDepth: depth,
        })
        continue
      }
      const { source } = item
      if (source.kind === "event")
        out.push({ kind: "ledger-event", key: source.key, row: source.row, displayDepth: depth })
      else out.push(source)
    }
    segment = []
  }

  for (let index = 0; index < end; index++) {
    const row = rows[index]
    const depth = row.displayDepth ?? 0
    if (segmentDepth !== null && depth !== segmentDepth) flush()
    segmentDepth = depth
    segment.push(row)
  }
  flush()
  out.push(...rows.slice(end))
  return out
}

/** A board row as a coalescing item: only event rows can join a run. */
function ledgerItem(row: BoardRow): { kind: LedgerItemKind; source: BoardRow; row?: BoardEventRow } {
  if (row.kind === "event") return { kind: "event", source: row, row: row.row }
  return { kind: "message", source: row }
}

function messageMs(message: RenderableMessage): number {
  return new Date(message.createdAt).getTime()
}

function subtreeMessageCount(node: BranchNode): number {
  let count = node.messages.length
  for (const child of node.children) count += subtreeMessageCount(child)
  return count
}

function earliestMessageMs(nodes: BranchNode[]): number {
  let min = Number.POSITIVE_INFINITY
  const walk = (node: BranchNode) => {
    for (const message of node.messages) {
      const t = messageMs(message)
      if (t < min) min = t
    }
    for (const child of node.children) walk(child)
  }
  for (const node of nodes) walk(node)
  return min === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : min
}

/** The earliest own-message time of a branch conversation view (top-level rows
 *  only), for chronologically anchoring a branch whose fork message isn't drawn. */
function branchAnchorMs(branch: BranchConversationView): number {
  let min = Number.POSITIVE_INFINITY
  for (const message of branch.messages) {
    const t = messageMs(message)
    if (t < min) min = t
  }
  return min
}

/**
 * Flatten a {@link BranchGrouping} into ordered board rows, interleaving event
 * rows into the group whose stream owns them and inserting branch chrome:
 *
 * - `soft` → the two runs with one `seam` row between them (no indent). A
 *   down-seam whose first run is just the opener is convert-to-thread transport
 *   — the whole discussion lives in the thread by design — so it renders
 *   seamlessly as one run: no seam row, no split chrome, regardless of thread
 *   size. The seam marks only a flat discussion that migrated mid-conversation.
 * - `spanning` → base messages chronological; each occupied thread rendered as
 *   one contiguous group placed after its fork message's row (or anchored
 *   chronologically when its fork message isn't rendered), indented by
 *   `displayDepth`; a subtree past depth 2 collapses to one `continue-thread` row.
 * - branch conversation groups land immediately after their fork message's row;
 *   a branch whose fork message isn't drawn (the collapsed card's hidden middle)
 *   is appended after the run, chronological by its own earliest message.
 *
 * Same-author continuation never spans a group boundary and is reset by any seam,
 * branch group, event, or overflow row — exactly like {@link buildBoardRows}
 * resets on an interleaved event. Events earlier than the first rendered message
 * are dropped (the collapsed card's hidden middle), matching {@link buildBoardRows}.
 * An event on a stream with no rendered group (its messages sit in the hidden
 * middle, or a capture landed outside the occupied streams) still shows —
 * chronologically at the base level — never silently vanishing; only events under
 * a collapsed overflow subtree stay hidden with it.
 */
export function buildBranchedBoardRows(
  grouping: BranchGrouping,
  eventRows: BoardEventRow[],
  branchesByForkMessageId: Map<string, BranchConversationView[]>,
  openingMessageId?: string
): BoardRow[] {
  const firstMs = earliestMessageMs(grouping.roots)
  const renderedForkIds = new Set<string>()
  const eventsByStream = new Map<string, BoardEventRow[]>()
  for (const event of eventRows) {
    if (event.sortMs < firstMs) continue
    const list = eventsByStream.get(event.streamId)
    if (list) list.push(event)
    else eventsByStream.set(event.streamId, [event])
  }

  const groupedStreamIds = new Set<string>()
  const collectStreamIds = (node: BranchNode) => {
    groupedStreamIds.add(node.streamId)
    for (const child of node.children) collectStreamIds(child)
  }
  for (const node of grouping.roots) collectStreamIds(node)
  const orphanEvents: BoardEventRow[] = []
  for (const [streamId, list] of eventsByStream) {
    if (!groupedStreamIds.has(streamId)) orphanEvents.push(...list)
  }

  const out: BoardRow[] = []

  const emitChild = (node: BranchNode) => {
    if (node.overflow) {
      out.push({
        kind: "continue-thread",
        key: `continue:${node.streamId}`,
        streamId: node.streamId,
        hiddenCount: subtreeMessageCount(node),
        displayDepth: node.displayDepth,
      })
      return
    }
    emitRun([node])
  }

  function emitRun(nodes: BranchNode[], orphans: BoardEventRow[] = []): void {
    const present = new Set<string>()
    for (const node of nodes) for (const message of node.messages) present.add(message.id)

    type Item = {
      t: number
      slot: number
      depth: number
      message?: RenderableMessage
      event?: BoardEventRow
      child?: BranchNode
    }
    const items: Item[] = []
    for (const event of orphans) items.push({ t: event.sortMs, slot: 2, depth: 0, event })
    const forkChildren = new Map<string, BranchNode[]>()
    for (const node of nodes) {
      for (const message of node.messages)
        items.push({ t: messageMs(message), slot: 0, depth: node.displayDepth, message })
      for (const event of eventsByStream.get(node.streamId) ?? [])
        items.push({ t: event.sortMs, slot: 2, depth: node.displayDepth, event })
      for (const child of node.children) {
        if (child.forkMessageId && present.has(child.forkMessageId)) {
          const list = forkChildren.get(child.forkMessageId)
          if (list) list.push(child)
          else forkChildren.set(child.forkMessageId, [child])
        } else {
          const anchor = child.messages.length > 0 ? messageMs(child.messages[0]) : Number.POSITIVE_INFINITY
          items.push({ t: anchor, slot: 1, depth: child.displayDepth, child })
        }
      }
    }
    items.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.slot - b.slot))

    let prev: RenderableMessage | null = null
    for (const item of items) {
      if (item.message) {
        const continuation = prev != null && isContinuation(prev, item.message)
        out.push({
          kind: "message",
          key: item.message.id,
          message: item.message,
          continuation,
          displayDepth: item.depth,
        })
        prev = item.message
        for (const branch of branchesByForkMessageId.get(item.message.id) ?? []) {
          renderedForkIds.add(item.message.id)
          out.push({ kind: "branch-group", key: `branch:${branch.conversationId}`, branch, displayDepth: item.depth })
          prev = null
        }
        for (const child of forkChildren.get(item.message.id) ?? []) {
          emitChild(child)
          prev = null
        }
      } else if (item.event) {
        out.push({ kind: "event", key: item.event.key, row: item.event, displayDepth: item.depth })
        prev = null
      } else if (item.child) {
        emitChild(item.child)
        prev = null
      }
    }
  }

  // A down-crossing whose pre-boundary run is the lone opener is the
  // convert-to-thread signature (a first reply to a lone post files into a
  // thread): the thread IS the conversation, so no seam ever — not a size
  // threshold; the run stays opener-only however large the thread grows.
  // The single pre-boundary message must be the conversation's actual opener:
  // on a collapsed card the flattener sees a trailing reply-only window, so a
  // migrated discussion whose window happens to start with one channel reply
  // would otherwise misfire as "converted" here and drop the seam it shows once
  // expanded. Matching the opener id keeps the classification window-independent.
  const convertedOpener =
    grouping.kind === "soft" &&
    grouping.softSeam?.direction === "down" &&
    grouping.roots[0]?.messages.length === 1 &&
    openingMessageId != null &&
    grouping.roots[0]?.messages[0]?.id === openingMessageId

  if (grouping.kind === "soft" && grouping.softSeam && !convertedOpener) {
    const [runA, runB] = grouping.roots
    // Orphan events split at the seam so each lands in its chronological run.
    const runBStart = runB && runB.messages.length > 0 ? messageMs(runB.messages[0]) : Number.POSITIVE_INFINITY
    if (runA)
      emitRun(
        [runA],
        orphanEvents.filter((event) => event.sortMs < runBStart)
      )
    out.push({
      kind: "seam",
      key: `seam:${grouping.softSeam.streamId}`,
      streamId: grouping.softSeam.streamId,
      direction: grouping.softSeam.direction,
      displayDepth: 0,
    })
    if (runB)
      emitRun(
        [runB],
        orphanEvents.filter((event) => event.sortMs >= runBStart)
      )
  } else {
    emitRun(grouping.roots, orphanEvents)
  }

  // Branches whose fork message wasn't drawn (it sits in the collapsed card's
  // hidden middle) still render — appended after the run, chronological by their
  // own earliest message so a just-forked topic lands where its activity sits.
  const unplaced: BranchConversationView[] = []
  for (const [forkMessageId, branches] of branchesByForkMessageId) {
    if (renderedForkIds.has(forkMessageId)) continue
    unplaced.push(...branches)
  }
  unplaced.sort((a, b) => branchAnchorMs(a) - branchAnchorMs(b))
  for (const branch of unplaced) {
    out.push({ kind: "branch-group", key: `branch:${branch.conversationId}`, branch, displayDepth: 0 })
  }

  return out
}

/**
 * Renders a non-message board row, reusing the timeline's own row components so a
 * board trace/memo/follow-up is identical to its timeline counterpart. Message
 * rows stay with the surface's own renderer (they carry card-specific read-state
 * and action wiring), so this only handles the event kinds. A `CachedEvent` is a
 * structural superset of `StreamEvent`, so the rail rows pass straight through.
 */
export function BoardEventRowItem({
  row,
  workspaceId,
  onRedirectSession,
}: {
  row: BoardEventRow
  workspaceId: string
  /** Open + focus the card's reply composer for a running session's Redirect. */
  onRedirectSession?: () => void
}) {
  switch (row.kind) {
    case "session":
      return (
        <div className="px-3 sm:px-4">
          <BoardAgentSessionRow
            events={row.events as StreamEvent[]}
            workspaceId={workspaceId}
            onRedirectSession={onRedirectSession}
          />
        </div>
      )
    case "command":
      // Same horizontal inset the timeline gives the chip (event-list wraps it
      // in px-3 sm:px-6) — bare, its hover highlight bleeds past the content column.
      return (
        <div className="px-3 sm:px-6">
          <CommandEvent events={row.events as StreamEvent[]} />
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
    case "delegation":
      return (
        <DelegationEvent
          event={row.event as StreamEvent}
          workspaceId={workspaceId}
          streamId={row.streamId}
          statusPatch={row.statusPatch}
        />
      )
    default: {
      const exhaustive: never = row
      return exhaustive
    }
  }
}

const LEDGER_EVENT_ICONS: Record<BoardEventRow["kind"], ReactNode> = {
  session: <Bot className="size-3" />,
  command: <SquareSlash className="size-3" />,
  memo: <Sparkles className="size-3 text-amber-500" />,
  followUp: <Clock className="size-3" />,
  delegation: <TerminalSquare className="size-3" />,
}

type OpenMemo = { memoId: string; title: string }

function ledgerDescriptor(
  row: BoardEventRow,
  traceUrl: (sessionId: string) => string,
  onOpenMemo: (memo: OpenMemo) => void
) {
  const content = ledgerEventContent(row, { traceUrl })
  return {
    key: content.key,
    icon: LEDGER_EVENT_ICONS[content.kind],
    label: content.label,
    meta: content.meta,
    href: content.href,
    onOpen: content.memo ? () => onOpenMemo(content.memo as OpenMemo) : undefined,
  } satisfies LedgerEventDescriptor
}

/**
 * One event compressed to a ledger line. Its tap affordance is the kind's own:
 * a session opens the trace view its full card links to, a single capture opens
 * the SAME in-place `MemoPreviewDialog` the full capture row does (never a
 * navigation off the board — the dialog's footer carries the deep link). Follow-
 * ups and delegations act only through buttons on their full cards, so their
 * lines are non-interactive.
 */
export function LedgerBoardEventRow({ row, workspaceId }: { row: BoardEventRow; workspaceId: string }) {
  const { getTraceUrl } = useTrace()
  const [openMemo, setOpenMemo] = useState<OpenMemo | null>(null)
  const descriptor = ledgerDescriptor(row, getTraceUrl, setOpenMemo)
  return (
    <>
      <LedgerEventRow
        icon={descriptor.icon}
        label={descriptor.label}
        meta={descriptor.meta}
        href={descriptor.href}
        onOpen={descriptor.onOpen}
      />
      <LedgerMemoPreview workspaceId={workspaceId} memo={openMemo} onClose={() => setOpenMemo(null)} />
    </>
  )
}

/** A coalesced run of ledger event lines, expanding in place. */
export function LedgerBoardEventGroup({
  rows,
  workspaceId,
  expanded,
  onToggle,
}: {
  rows: BoardEventRow[]
  workspaceId: string
  expanded: boolean
  onToggle: () => void
}) {
  const { getTraceUrl } = useTrace()
  const [openMemo, setOpenMemo] = useState<OpenMemo | null>(null)
  return (
    <>
      <LedgerEventGroup
        events={rows.map((row) => ledgerDescriptor(row, getTraceUrl, setOpenMemo))}
        expanded={expanded}
        onToggle={onToggle}
      />
      <LedgerMemoPreview workspaceId={workspaceId} memo={openMemo} onClose={() => setOpenMemo(null)} />
    </>
  )
}

function LedgerMemoPreview({
  workspaceId,
  memo,
  onClose,
}: {
  workspaceId: string
  memo: OpenMemo | null
  onClose: () => void
}) {
  return (
    <MemoPreviewDialog
      open={memo !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      workspaceId={workspaceId}
      memoId={memo?.memoId ?? ""}
      fallbackTitle={memo?.title ?? ""}
    />
  )
}

const SESSION_TERMINAL_EVENT_TYPES = new Set<string>([
  "agent_session:completed",
  "agent_session:failed",
  "agent_session:deleted",
])

/**
 * An agent-session row on a board card / conversation panel. A terminal session
 * carries its final step + message counts in its own payload, so it renders the
 * shared card straight. A still-running session has no counts in its events — they
 * arrive as ephemeral `agent_session:progress` socket ticks — so it delegates to
 * {@link BoardRunningSessionRow}, which mounts the same live rail the timeline runs
 * (`useAgentActivity`, event-list.tsx). Without that subscription the card sits at
 * "0 steps" until the terminal event lands. Splitting keeps the subscription off
 * the many past-trace rows a board carries, and confines a progress-tick re-render
 * to this leaf instead of the whole card.
 */
function BoardAgentSessionRow({
  events,
  workspaceId,
  onRedirectSession,
}: {
  events: StreamEvent[]
  workspaceId: string
  onRedirectSession?: () => void
}) {
  const running = !events.some((event) => SESSION_TERMINAL_EVENT_TYPES.has(event.eventType))
  if (!running) return <AgentSessionEvent events={events} />
  return <BoardRunningSessionRow events={events} workspaceId={workspaceId} onRedirectSession={onRedirectSession} />
}

function BoardRunningSessionRow({
  events,
  workspaceId,
  onRedirectSession,
}: {
  events: StreamEvent[]
  workspaceId: string
  onRedirectSession?: () => void
}) {
  const socket = useSocket()
  const streamId = events[0]!.streamId
  const stopAgentSession = useStopAgentSession(socket, workspaceId, streamId)
  const steerAgentSession = useSteerAgentSession(workspaceId, streamId)
  const userId = useWorkspaceUserId(workspaceId)
  const activity = useAgentActivity(events, socket, workspaceId, userId)
  const sessionId = events.reduce<string | null>((found, event) => found ?? getSessionId(event), null)
  // `useAgentActivity` keys by trigger message and also carries socket-only
  // sessions from other rows on the shared socket, so match this row's session by
  // id — the same lookup event-list.tsx does off the activity map.
  let live: MessageAgentActivity | undefined
  if (sessionId != null) {
    for (const entry of activity.values()) {
      if (entry.sessionId === sessionId) {
        live = entry
        break
      }
    }
  }
  return (
    <AgentSessionEvent
      events={events}
      liveCounts={live ? { stepCount: live.stepCount, messageCount: live.messageCount } : undefined}
      liveSubstep={live?.substep ?? null}
      onStopSession={stopAgentSession}
      onRedirect={onRedirectSession}
      onSteerSession={steerAgentSession}
    />
  )
}
