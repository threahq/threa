import { db, sequenceToNum, type CachedEvent } from "@/db"
import {
  StreamTypes,
  type StreamEvent,
  type Stream,
  type StreamBootstrap,
  type LastMessagePreview,
  type LinkPreviewSummary,
  type ThreadSummary,
  type WorkspaceBootstrap,
  type BotRuntimePresenceSummary,
  type JSONContent,
} from "@threa/types"
import { seedDecryption } from "@/lib/crypto/decrypt-cache"
import type { AttachmentRef } from "@/lib/crypto/attachment-crypto"
import type { SyncEventSource } from "./socket-event-gate"
import { commandsApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import { delegationKeys } from "@/hooks/use-stream-delegations"
import type { QueryClient } from "@tanstack/react-query"
import { commitCounterMutation } from "./catch-up-batch"
import {
  applyMovedSourceOrdinal,
  dropMessageActivities,
  dropReactionActivity,
  rehomeActivities,
} from "./unread-counters"
import { upsertActiveCall, updateCallParticipants } from "@/stores/active-calls-store"

// ============================================================================
// Bootstrap application — writes stream bootstrap data to IndexedDB
// ============================================================================

export interface CachedStreamBootstrap extends StreamBootstrap {
  windowVersion: number
}

/** True when a runtime in this state contributes session-control commands to the stream's command set (mirrors the backend's available/busy gate). */
function commandsLive(presence: BotRuntimePresenceSummary | null | undefined): boolean {
  return presence?.status === "available" || presence?.status === "busy"
}

function preserveDmDisplayName(nextStream: Stream, previousStream?: Stream): Stream {
  const isDmWithNullName = nextStream.type === StreamTypes.DM && nextStream.displayName == null
  if (isDmWithNullName && previousStream?.displayName) {
    return { ...nextStream, displayName: previousStream.displayName }
  }
  return nextStream
}

function dedupeAndSortEvents(events: StreamEvent[]): StreamEvent[] {
  const byId = new Map<string, StreamEvent>()
  for (const event of events) {
    byId.set(event.id, event)
  }
  return Array.from(byId.values()).sort((a, b) => {
    const seqA = BigInt(a.sequence)
    const seqB = BigInt(b.sequence)
    if (seqA < seqB) return -1
    if (seqA > seqB) return 1
    return 0
  })
}

function maxSequence(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b
}

export function toCachedStreamBootstrap(
  bootstrap: StreamBootstrap,
  previous?: CachedStreamBootstrap,
  options?: { incrementWindowVersionOnReplace?: boolean }
): CachedStreamBootstrap {
  const nextStream = preserveDmDisplayName(bootstrap.stream, previous?.stream)
  const shouldIncrementWindowVersion = bootstrap.syncMode === "replace" && options?.incrementWindowVersionOnReplace
  const shouldAppend = bootstrap.syncMode === "append" && previous
  return {
    ...bootstrap,
    stream: nextStream,
    events: shouldAppend ? dedupeAndSortEvents([...previous.events, ...bootstrap.events]) : bootstrap.events,
    latestSequence: shouldAppend
      ? maxSequence(previous.latestSequence, bootstrap.latestSequence)
      : bootstrap.latestSequence,
    hasOlderEvents: shouldAppend ? previous.hasOlderEvents : bootstrap.hasOlderEvents,
    windowVersion: shouldIncrementWindowVersion ? (previous?.windowVersion ?? 0) + 1 : (previous?.windowVersion ?? 0),
  }
}

export async function getLatestPersistedSequence(streamId: string): Promise<string | null> {
  const latestEvent = await db.events
    .where("[streamId+_sequenceNum]")
    .between([streamId, 0], [streamId, Number.MAX_SAFE_INTEGER], true, true)
    .reverse()
    .filter((event) => event._status == null)
    .first()

  return latestEvent?.sequence ?? null
}

export interface PersistedTail {
  /** Global sequence of the newest persisted row — the `bootstrap?after=` catch-up cursor. */
  latestSequence: string | null
  /**
   * Highest `broadcastSequence` among recent persisted rows (broadcast order
   * matches global order, so the first stamped row scanning downward holds
   * the max). `null` when the cache predates the broadcast counter.
   */
  latestBroadcastSequence: string | null
}

/**
 * Bound on the downward scan for a stamped row. Unstamped rows above the
 * last stamped one only occur transitionally (pre-INV-61 cached rows);
 * past the bound we fall back to the global-sequence gap heuristic.
 */
const TAIL_SCAN_LIMIT = 50

export async function getPersistedTail(streamId: string): Promise<PersistedTail> {
  const recent = await db.events
    .where("[streamId+_sequenceNum]")
    .between([streamId, 0], [streamId, Number.MAX_SAFE_INTEGER], true, true)
    .reverse()
    .filter((event) => event._status == null)
    .limit(TAIL_SCAN_LIMIT)
    .toArray()

  return {
    latestSequence: recent[0]?.sequence ?? null,
    latestBroadcastSequence: recent.find((event) => event.broadcastSequence != null)?.broadcastSequence ?? null,
  }
}

function getBootstrapWindowFloor(events: StreamEvent[]): bigint | null {
  if (events.length === 0) return null
  return events.reduce((min, event) => {
    const sequence = BigInt(event.sequence)
    return sequence < min ? sequence : min
  }, BigInt(events[0].sequence))
}

function getBootstrapWindowCeiling(events: StreamEvent[], latestSequence: string): bigint {
  if (events.length === 0) return BigInt(latestSequence)
  return events.reduce((max, event) => {
    const sequence = BigInt(event.sequence)
    return sequence > max ? sequence : max
  }, BigInt(events[0].sequence))
}

async function cleanupStaleOptimisticEvents(streamId: string): Promise<void> {
  const tempEvents = await db.events
    .where("streamId")
    .equals(streamId)
    .filter((e) => e.id.startsWith("temp_"))
    .toArray()

  const pendingCommandEventIds = new Set(
    (await db.pendingOperations.where("type").equals("dispatch_command").toArray())
      .map((op) => op.payload.optimisticEventId)
      .filter((id): id is string => typeof id === "string")
  )

  for (const temp of tempEvents) {
    if (temp._status === "failed") continue
    const stillPending = await db.pendingMessages.get(temp.id)
    if (!stillPending && !pendingCommandEventIds.has(temp.id)) {
      await db.events.delete(temp.id)
    }
  }
}

async function pruneBootstrapReplaceWindow(streamId: string, bootstrap: StreamBootstrap): Promise<void> {
  const bootstrapEventIds = new Set(bootstrap.events.map((event) => event.id))
  const bootstrapWindowFloor = getBootstrapWindowFloor(bootstrap.events)
  if (bootstrapWindowFloor === null) return

  // Use the actual max event sequence as the ceiling, NOT latestSequence.
  // latestSequence can be higher than the max returned event when new events
  // are created between the server's event query and sequence query. Using
  // latestSequence as the ceiling would delete valid socket events that
  // arrived in that gap (subscribe-then-fetch race, INV-53).
  const bootstrapWindowCeiling = getBootstrapWindowCeiling(bootstrap.events, bootstrap.latestSequence)

  const staleWindowEvents = await db.events
    .where("streamId")
    .equals(streamId)
    .filter((event) => {
      if (bootstrapEventIds.has(event.id)) return false
      if (event._status === "pending" || event._status === "failed") return false
      const sequence = BigInt(event.sequence)
      return sequence >= bootstrapWindowFloor && sequence <= bootstrapWindowCeiling
    })
    .toArray()

  for (const staleEvent of staleWindowEvents) {
    await db.events.delete(staleEvent.id)
  }
}

/**
 * Whether putting `candidate` over `existing` would change nothing the app
 * can observe. Skipping these puts matters for perceived performance: every
 * write to `db.events` re-runs the timeline's `useLiveQuery`, and a bootstrap
 * that rewrites byte-identical rows forces a full-window re-render for no
 * user-visible change. `_cachedAt` is bookkeeping (nothing reads it for
 * eviction or rendering), so a row that differs only by `_cachedAt` is a
 * no-op. Rows carrying optimistic `_status` are never skipped — the put
 * intentionally clears that flag on confirm.
 */
function isNoOpRewrite(existing: CachedEvent, candidate: CachedEvent): boolean {
  if (existing._status !== undefined) return false
  return (
    existing.streamId === candidate.streamId &&
    existing.workspaceId === candidate.workspaceId &&
    existing.sequence === candidate.sequence &&
    existing.broadcastSequence === candidate.broadcastSequence &&
    existing._clientId === candidate._clientId &&
    existing._sequenceNum === candidate._sequenceNum &&
    existing.eventType === candidate.eventType &&
    existing.actorId === candidate.actorId &&
    existing.actorType === candidate.actorType &&
    existing.createdAt === candidate.createdAt &&
    JSON.stringify(existing.payload) === JSON.stringify(candidate.payload)
  )
}

async function writeBootstrapEventsAndStream(
  workspaceId: string,
  streamId: string,
  bootstrap: StreamBootstrap,
  now: number
): Promise<void> {
  await cleanupStaleOptimisticEvents(streamId)

  if (bootstrap.syncMode !== "append") {
    await pruneBootstrapReplaceWindow(streamId, bootstrap)
  }

  if (bootstrap.events.length > 0) {
    // For message_created events, the bootstrap snapshot can race against
    // socket updates that already landed in IDB. We resolve this in two
    // tiers:
    //
    //   1. Freshness skip — if the row was patched by a socket handler
    //      AFTER the backend's snapshot was taken (`_patchedAt > snapshotMs`),
    //      bootstrap's enrichment for that row may be stale, so we preserve
    //      the existing row entirely. Example: a reaction:added arrives at
    //      the client before the bootstrap response; the bootstrap's
    //      reactions enrichment query ran before the reaction committed, so
    //      its payload omits the reaction — overwriting would lose it.
    //
    //   2. Per-field merge — if the row wasn't patched after the snapshot
    //      (or no snapshotAt is on the wire), we still merge per-field so
    //      bootstrap-internal-inconsistency races (e.g.
    //      getThreadsWithReplyCounts and getThreadSummaries seeing different
    //      snapshots of the same reply) can't omit a field that was already
    //      populated in IDB.
    //
    // Other event types' payloads are immutable post-creation, so a plain
    // overwrite is equivalent for them.
    const snapshotMs = bootstrap.snapshotAt ? Date.parse(bootstrap.snapshotAt) : null
    const existingRows = await db.events.bulkGet(bootstrap.events.map((e) => e.id))
    const existingById = new Map(
      existingRows.filter((row): row is NonNullable<typeof row> => row != null).map((row) => [row.id, row] as const)
    )

    // The bootstrap can carry the server copy of a message whose optimistic
    // temp_* row is still in IDB: a reload can interrupt the send pipeline
    // after the server committed, so the message:created echo that normally
    // swaps optimistic → real (handleMessageCreated) died with the old page —
    // and the queue's re-send hits the backend's idempotent replay path, which
    // returns the existing message WITHOUT emitting a new event, so no echo
    // ever comes. Without this swap both copies render until the next
    // bootstrap whose cleanupStaleOptimisticEvents happens to run after the
    // outbox row is gone. Mirror the echo swap here: real row written first
    // (bulkPut below), optimistic row + outbox entry deleted after, E2E
    // decrypt cache seeded from the optimistic plaintext.
    const messageCreatedWithClientId = bootstrap.events
      .filter((e) => e.eventType === "message_created")
      .map((e) => ({ realEvent: e, clientMessageId: (e.payload as { clientMessageId?: string }).clientMessageId }))
      .filter((pair): pair is { realEvent: StreamEvent; clientMessageId: string } => !!pair.clientMessageId)
    const optimisticRows = await db.events.bulkGet(messageCreatedWithClientId.map((pair) => pair.clientMessageId))
    const optimisticSwaps = messageCreatedWithClientId.flatMap(({ realEvent }, i) => {
      const optimistic = optimisticRows[i]
      return optimistic ? [{ realEvent, optimistic }] : []
    })
    const optimisticByRealEventId = new Map(optimisticSwaps.map((s) => [s.realEvent.id, s.optimistic] as const))

    const toWrite: CachedEvent[] = []
    for (const e of bootstrap.events) {
      const base = { ...e, workspaceId, _sequenceNum: sequenceToNum(e.sequence), _cachedAt: now }
      const existing = existingById.get(e.id)
      if (e.eventType !== "message_created") {
        if (existing === undefined || !isNoOpRewrite(existing, base)) {
          toWrite.push(base)
        }
        continue
      }
      if (!existing) {
        // Same carry as the echo swap: a board reply's conversationId lives
        // only on the optimistic payload (the server event doesn't carry it),
        // so bring it across or the card row blinks out until the
        // conversation:updated aggregate lands.
        const carriedConversationId = (
          optimisticByRealEventId.get(e.id)?.payload as { conversationId?: string } | undefined
        )?.conversationId
        toWrite.push(
          carriedConversationId && !(base.payload as { conversationId?: string }).conversationId
            ? {
                ...base,
                payload: { ...(base.payload as Record<string, unknown>), conversationId: carriedConversationId },
              }
            : base
        )
        continue
      }
      if (snapshotMs !== null && existing._patchedAt !== undefined && existing._patchedAt > snapshotMs) {
        // Skip the put — existing row is fresher than this snapshot.
        continue
      }
      const merged: CachedEvent = {
        ...base,
        payload: {
          ...(existing.payload as Record<string, unknown>),
          ...(e.payload as Record<string, unknown>),
        },
        // Preserve the patch watermark so subsequent bootstraps still see
        // that this row has been touched by socket activity.
        _patchedAt: existing._patchedAt,
      }
      if (!isNoOpRewrite(existing, merged)) {
        toWrite.push(merged)
      }
    }

    if (toWrite.length > 0) {
      await db.events.bulkPut(toWrite)
    }

    // Real rows are in place (bulkPut above, or already present via a skipped
    // rewrite) — now drop the optimistic copies and their outbox entries so a
    // liveQuery frame never shows neither copy. Deleting the outbox row also
    // stops the queue from replaying a send the server already committed.
    for (const { realEvent, optimistic } of optimisticSwaps) {
      await db.events.delete(optimistic.id)
      await db.pendingMessages.delete(optimistic.id)
      const plaintext = readPlaintextContent(optimistic.payload)
      if (plaintext && isEncryptedPayload(realEvent.payload)) {
        seedDecryption(realEvent.id, plaintext)
      }
    }
  }

  await applyBootstrapThreadStates(streamId, bootstrap, now)

  // Merge stream metadata without destroying fields that only exist on the
  // workspace bootstrap's StreamWithPreview (e.g. lastMessagePreview, which
  // is the sidebar's activity sort key). Use update() for existing records
  // and fall back to put() if the stream doesn't exist in IDB yet.
  const stream = preserveDmDisplayName(bootstrap.stream)
  const fullStreamData = {
    ...stream,
    notificationLevel: bootstrap.membership?.notificationLevel,
    lastReadEventId: bootstrap.membership?.lastReadEventId,
    // Mirror the persisted ContextBag into IDB so the timeline can read it
    // synchronously on first paint via the `useWorkspaceStreams` cache —
    // matches how attachments live on the message payload (sync from IDB).
    contextBag: bootstrap.contextBag,
    _cachedAt: now,
  }
  const isDmWithNullName = stream.type === StreamTypes.DM && stream.displayName == null
  if (isDmWithNullName) {
    const { displayName: _, ...withoutDisplayName } = fullStreamData
    const updated = await db.streams.update(stream.id, withoutDisplayName)
    if (updated === 0) {
      await db.streams.put(fullStreamData)
    }
    return
  }

  const updated = await db.streams.update(stream.id, fullStreamData)
  if (updated === 0) {
    await db.streams.put(fullStreamData)
  }
}

/**
 * Heal thread state on already-persisted parent rows from the bootstrap's
 * `threadStates` map (append-mode responses). Thread patches (`message:updated`
 * reply_count) have no broadcast sequence and mutate rows behind the append
 * cursor, so one missed live patch would otherwise stay stale until a hard
 * refresh — this makes every stream open converge on the server's state.
 *
 * Same freshness rule as the event merge above: rows patched by a socket
 * handler AFTER the bootstrap snapshot keep their (newer) values. Only
 * `_cachedAt` is bumped — this is bootstrap data, not a socket patch, so
 * `_patchedAt` must stay untouched for later bootstraps to reason against.
 */
async function applyBootstrapThreadStates(streamId: string, bootstrap: StreamBootstrap, now: number): Promise<void> {
  if (!bootstrap.threadStates || bootstrap.threadStates.length === 0) return

  const snapshotMs = bootstrap.snapshotAt ? Date.parse(bootstrap.snapshotAt) : null
  const stateByMessageId = new Map(bootstrap.threadStates.map((state) => [state.parentMessageId, state]))

  await db.events
    .where("[streamId+eventType]")
    .equals([streamId, "message_created"])
    .filter((event) => {
      const state = stateByMessageId.get((event.payload as { messageId?: string })?.messageId ?? "")
      if (!state) return false
      if (snapshotMs !== null && event._patchedAt !== undefined && event._patchedAt > snapshotMs) return false
      const payload = event.payload as { threadId?: string; replyCount?: number; threadSummary?: unknown }
      return (
        payload.threadId !== state.threadId ||
        (payload.replyCount ?? 0) !== state.replyCount ||
        JSON.stringify(payload.threadSummary ?? null) !== JSON.stringify(state.threadSummary)
      )
    })
    .modify((event) => {
      const state = stateByMessageId.get((event.payload as { messageId?: string })?.messageId ?? "")
      if (!state) return
      event.payload = {
        ...(event.payload as Record<string, unknown>),
        threadId: state.threadId,
        replyCount: state.replyCount,
        threadSummary: state.threadSummary,
      }
      event._cachedAt = now
    })
}

/**
 * Write stream bootstrap data to IndexedDB (merge, not replace).
 *
 * Events are MERGED into IDB via bulkPut. We never delete events here
 * because socket events may have arrived between the bootstrap snapshot
 * and this write (subscribe-then-fetch, INV-53). Deleting would lose them.
 *
 * Stale optimistic events (temp_* no longer in the send queue) are cleaned
 * up since they'll never receive a server confirmation.
 *
 * The read layer (useEvents) handles windowing — it filters IDB events to
 * the bootstrap window + newer, so stale events from previous sessions
 * don't leak into the display.
 */
export async function applyStreamBootstrap(
  workspaceId: string,
  streamId: string,
  bootstrap: StreamBootstrap
): Promise<void> {
  const now = Date.now()
  await db.transaction("rw", [db.events, db.streams, db.pendingMessages, db.pendingOperations], async () => {
    await writeBootstrapEventsAndStream(workspaceId, streamId, bootstrap, now)
  })
  seedStreamActiveCall(workspaceId, streamId, bootstrap)
}

/**
 * Seed the active-calls store with this stream's live call (INV-53 pair for the
 * timeline card's live avatars + the reload rejoin bar). The workspace bootstrap
 * seeds dot PRESENCE; this refines the joined roster for the stream in view.
 * Calls live only on non-thread roots today, so rootStreamId equals streamId.
 * A plain module-store write (not IDB), so it is safe from inside a caller's
 * Dexie transaction — both bootstrap paths (initial open AND reconnect re-apply)
 * must run it or the open stream's roster goes stale after a reconnect.
 */
function seedStreamActiveCall(workspaceId: string, streamId: string, bootstrap: StreamBootstrap): void {
  if (!bootstrap.activeCall) return
  upsertActiveCall(workspaceId, {
    callId: bootstrap.activeCall.callId,
    streamId,
    rootStreamId: streamId,
    mode: bootstrap.activeCall.mode,
    participantCount: bootstrap.activeCall.participantCount,
    participantUserIds: bootstrap.activeCall.participantUserIds,
  })
}

/**
 * Same as `applyStreamBootstrap` but written for callers that have already
 * opened a `db.transaction` — it delegates to `writeBootstrapEventsAndStream`
 * and performs the same store-side active-call seeding.
 */
export async function applyStreamBootstrapInCurrentTransaction(
  workspaceId: string,
  streamId: string,
  bootstrap: StreamBootstrap,
  now = Date.now()
): Promise<void> {
  await writeBootstrapEventsAndStream(workspaceId, streamId, bootstrap, now)
  seedStreamActiveCall(workspaceId, streamId, bootstrap)
}

// ============================================================================
// Socket event handler payloads
// ============================================================================

interface MessageEventPayload {
  workspaceId: string
  streamId: string
  event: StreamEvent
}

interface MessageDeletedPayload {
  workspaceId: string
  streamId: string
  messageId: string
  deletedAt: string
}

interface MessagesMovedPayload {
  workspaceId: string
  streamId: string
  sourceStreamId: string
  destinationStreamId: string
  targetMessageId: string
  movedMessageIds: string[]
  thread: Stream
  events: StreamEvent[]
  removedEventIds: string[]
  /** Tombstone event inserted into the source stream — appended to the
   *  source-side IDB cache so the timeline keeps a "moved → thread" trace. */
  sourceTombstoneEvent: StreamEvent
  /** Authoritative replyCount for the drop-target after the move (see backend payload doc). */
  parentReplyCount: number
  /** Recomputed thread summary for the drop-target — same shape as `message:updated` ships. */
  parentThreadSummary: ThreadSummary | null
  /** Source stream's post-move `message_created` count. Fix A1: SET onto the
   *  source `latestOrdinals` so the count that dropped when rows relocated heals
   *  (max-merge alone never corrects it). Optional during rollout → absent keeps
   *  today's behavior. See docs/sparse-read-overlay-design.md. */
  sourceMessageOrdinal?: number
}

interface ReactionPayload {
  workspaceId: string
  streamId: string
  messageId: string
  emoji: string
  userId: string
}

interface StreamCreatedPayload {
  workspaceId: string
  streamId: string
  stream: Stream
}

interface MessageUpdatedPayload {
  workspaceId: string
  streamId: string
  messageId: string
  updateType: "reply_count" | "content"
  replyCount?: number
  contentMarkdown?: string
  /**
   * For reply_count updates, the backend recomputes the thread summary and
   * sends it alongside so ThreadCard can refresh its preview/participants
   * without waiting for the next bootstrap. `null` = last reply was deleted.
   */
  threadSummary?: ThreadSummary | null
  /**
   * For reply_count updates, the thread stream's id. The card needs a
   * navigable thread id, and `stream:created` (its usual source) reaches only
   * clients in the parent's room at creation time — carrying the id on every
   * reply patch makes each patch self-sufficient for rendering the card.
   */
  threadId?: string | null
}

interface CommandEventPayload {
  workspaceId: string
  streamId: string
  event: StreamEvent
  authorId: string
}

interface AgentSessionEventPayload {
  workspaceId: string
  streamId: string
  event: StreamEvent
}

interface MemberRemovedPayload {
  workspaceId: string
  streamId: string
  memberId: string
  event: StreamEvent
}

interface MemosCapturedPayload {
  workspaceId: string
  streamId: string
  event: StreamEvent
}

interface StreamLifecycleEventPayload {
  workspaceId: string
  streamId: string
  stream: Stream
  event: StreamEvent
}

interface DescriptionSetPayload {
  workspaceId: string
  streamId: string
  event: StreamEvent
}

interface LinkPreviewReadyPayload {
  workspaceId: string
  streamId: string
  messageId: string
  previews: LinkPreviewSummary[]
}

/**
 * The live `link_preview:ready` broadcast can't carry per-viewer `inAppData` (no
 * single viewer to resolve against), so it would wipe data the history fetch
 * already baked onto the cached event. Carry that `inAppData` forward by preview
 * id when the incoming copy lacks it, so an in-app card keeps rendering
 * synchronously instead of dropping back to the async resolve. Matching on id is
 * safe because a preview row is keyed by normalized url: the same id always means
 * the same link target, so the carried tier still applies; a preview pointing at a
 * different target carries a different id and is correctly left to resolve async.
 */
export function preserveBakedInAppData(
  incoming: LinkPreviewSummary[],
  existing: LinkPreviewSummary[] | undefined
): LinkPreviewSummary[] {
  const baked = new Map(existing?.filter((p) => p.inAppData).map((p) => [p.id, p.inAppData]))
  if (baked.size === 0) return incoming
  return incoming.map((p) => (p.inAppData || !baked.has(p.id) ? p : { ...p, inAppData: baked.get(p.id) }))
}

// ============================================================================
// Helper: find and update a message_created event in IndexedDB
// ============================================================================

export async function updateMessageEvent(
  streamId: string,
  messageId: string,
  updater: (payload: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  // Use compound index to narrow to message_created events for this stream,
  // then filter by messageId in the payload (not indexed but over a small set).
  // modify() runs the callback inside a readwrite cursor so the read and write
  // are atomic. This prevents lost updates when multiple socket handlers
  // (messages:moved, stream:created, message:updated) update the same parent
  // message concurrently — the second transaction sees the first's writes.
  await db.events
    .where("[streamId+eventType]")
    .equals([streamId, "message_created"])
    .filter((e) => (e.payload as { messageId?: string })?.messageId === messageId)
    .modify((event) => {
      const updatedPayload = updater(event.payload as Record<string, unknown>)
      const now = Date.now()
      event.payload = updatedPayload
      event._cachedAt = now
      // Freshness watermark — see `_patchedAt` doc on CachedEvent. Only
      // bumped by socket-handler patches (and the optimistic helpers below
      // that mirror them); bootstrap apply leaves it alone so a later
      // bootstrap response can decide whether its enrichment is stale.
      event._patchedAt = now
    })
}

/**
 * Optimistically update a parent message's replyCount and threadId in IDB.
 *
 * Called after draft thread submission so the reply count appears instantly
 * when the user navigates back via breadcrumb. The socket handler for
 * message:updated may miss this event because the panel navigated away
 * from the parent stream (handlers were cleaned up on unmount).
 */
export async function optimisticReplyCountUpdate(
  parentStreamId: string,
  parentMessageId: string,
  threadId: string
): Promise<void> {
  await updateMessageEvent(parentStreamId, parentMessageId, (p) => ({
    ...p,
    threadId,
    replyCount: ((p.replyCount as number) ?? 0) + 1,
  }))
}

/**
 * Swap the threadId on a parent message without touching replyCount.
 *
 * Used when promoting a draft thread: the initial optimistic update set the
 * threadId to the draft panel ID (and incremented replyCount by 1) so the UI
 * surfaced the pending reply immediately. Once the real thread stream is
 * created, we swap the threadId to the server-assigned one so navigation
 * targets the real thread.
 */
export async function setParentThreadId(
  parentStreamId: string,
  parentMessageId: string,
  threadId: string
): Promise<void> {
  await updateMessageEvent(parentStreamId, parentMessageId, (p) => ({
    ...p,
    threadId,
  }))
}

// ============================================================================
// Socket event handlers — write exclusively to IndexedDB
// ============================================================================

/**
 * Register stream-level socket event handlers that write to IndexedDB only.
 * Returns a cleanup function that unregisters all handlers.
 *
 * The workspace bootstrap cache (TanStack Query) is still updated for
 * lastMessagePreview on message:created — this is a transitional coupling
 * that will be removed in Phase 3 when workspace data moves to IDB.
 */
function contentHasSharedMessage(contentJson: unknown): boolean {
  if (!contentJson || typeof contentJson !== "object") return false
  const node = contentJson as { type?: unknown; content?: unknown[] }
  if (node.type === "sharedMessage") return true
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (contentHasSharedMessage(child)) return true
    }
  }
  return false
}

/** Plaintext content carried by an optimistic (self-sent) event payload, if present. */
function readPlaintextContent(
  payload: unknown
): { contentMarkdown: string; contentJson: JSONContent; attachmentRefs: AttachmentRef[] } | null {
  const p = payload as { contentMarkdown?: unknown; contentJson?: unknown; attachmentRefs?: unknown } | undefined
  if (!p || typeof p.contentMarkdown !== "string" || !p.contentJson) return null
  // The optimistic row carries the sealed attachmentRefs (key/iv/filename) so
  // the seed below can render the sender's own E2E attachments without waiting
  // for a decrypt that the seed itself would suppress.
  const attachmentRefs = Array.isArray(p.attachmentRefs) ? (p.attachmentRefs as AttachmentRef[]) : []
  return { contentMarkdown: p.contentMarkdown, contentJson: p.contentJson as JSONContent, attachmentRefs }
}

/** Whether a server event payload is E2E-sealed (ciphertext + envelope on the wire). */
function isEncryptedPayload(payload: unknown): boolean {
  const p = payload as { ciphertext?: unknown; envelope?: unknown } | undefined
  return !!p && typeof p.ciphertext === "string" && !!p.envelope
}

export interface StreamSocketHandlerOptions {
  /**
   * Called after a live event was written whose sequence leaves a hole behind
   * the previously-latest persisted event — i.e. events were missed while this
   * client wasn't receiving (zombie socket, server bounce, a catch-up fetch
   * that raced live delivery). `afterSequence` is the pre-write latest, so a
   * `bootstrap?after=` fetch from it closes the hole (INV-53: overlap is safe,
   * gaps are not). When both sides carry a `broadcastSequence` the check is
   * exact (INV-61: the broadcast chain is dense for every viewer). Only the
   * transitional global-sequence fallback can report a gap that turns out to
   * be empty — the backfill is idempotent and self-quiets.
   */
  onSequenceGap?: (gap: { streamId: string; afterSequence: string }) => void
}

/**
 * Pre-write tail-gap check: returns the catch-up cursor (latest persisted
 * global sequence) when the incoming event skips past the persisted tail,
 * null when contiguous, older-than-tail, or there is nothing to gap against.
 *
 * The comparison runs on the dense broadcast chain when both sides are
 * stamped — exact, no false positives from other viewers' command events.
 * Unstamped events (own command echoes, pre-INV-61 caches) fall back to the
 * conservative global-sequence heuristic.
 */
export function detectSequenceGap(
  tail: PersistedTail,
  incoming: Pick<StreamEvent, "sequence" | "broadcastSequence">
): string | null {
  if (tail.latestSequence === null) return null
  if (incoming.broadcastSequence != null && tail.latestBroadcastSequence != null) {
    return Number(incoming.broadcastSequence) > Number(tail.latestBroadcastSequence) + 1 ? tail.latestSequence : null
  }
  return sequenceToNum(incoming.sequence) > sequenceToNum(tail.latestSequence) + 1 ? tail.latestSequence : null
}

export function registerStreamSocketHandlers(
  socket: SyncEventSource,
  workspaceId: string,
  streamId: string,
  queryClient: QueryClient,
  options?: StreamSocketHandlerOptions
): () => void {
  const onSequenceGap = options?.onSequenceGap

  const handleMessageCreated = async (payload: MessageEventPayload) => {
    if (payload.streamId !== streamId) return

    // E2E payloads stay as ciphertext + envelope at rest; decryption runs on
    // demand in the render path. The wire `contentMarkdown` / `contentJson`
    // for E2E messages is the backend placeholder, so the sidebar preview
    // write below is a placeholder-by-placeholder substitution — the sidebar
    // surfaces it as the sentinel via `stream.e2eEnabled`.
    const newEvent = payload.event
    const newPayload = newEvent.payload as {
      contentJson: unknown
      clientMessageId?: string
    }
    const now = Date.now()

    // When this is the echo of a message we sent, the optimistic row still holds
    // the plaintext we just encrypted. Capture it so we can seed the decrypt
    // cache for the server event id below — otherwise the encrypted server event
    // would flash "decrypting" as the optimistic row is swapped for the sent row.
    let optimisticPlaintext: {
      contentMarkdown: string
      contentJson: JSONContent
      attachmentRefs: AttachmentRef[]
    } | null = null

    // Set when this event's sequence reveals missed events behind it; reported
    // after the transaction commits so the backfill never runs inside it.
    let gapAfterSequence: string | null = null

    await db.transaction("rw", [db.events, db.pendingMessages], async () => {
      const existing = await db.events.get(newEvent.id)
      if (existing) return

      // Tail-gap check must read the latest BEFORE this write advances it.
      if (onSequenceGap) {
        gapAfterSequence = detectSequenceGap(await getPersistedTail(streamId), newEvent)
      }

      // Read the optimistic row (keyed by the client id the server echoes back)
      // BEFORE writing the real event, so we can carry forward state the server
      // event doesn't itself carry.
      let carriedConversationId: string | undefined
      if (newPayload.clientMessageId) {
        const optimistic = await db.events.get(newPayload.clientMessageId)
        optimisticPlaintext = readPlaintextContent(optimistic?.payload)
        // A board reply tags its optimistic event with the conversation it
        // attaches to; the server `message:created` does NOT carry that (the
        // conversation aggregate rides a separate `conversation:updated`). Carry
        // it onto the real event so the board card keeps showing the reply in the
        // window between this swap and the aggregate update — otherwise the row
        // would blink out (its id isn't in `conversation.messageIds` yet, and the
        // optimistic copy is about to be deleted). Read-side only; ignored by the
        // timeline. See `useBoardCardMessages`.
        carriedConversationId = (optimistic?.payload as { conversationId?: string } | undefined)?.conversationId
      }

      // Add the real event BEFORE deleting the optimistic one so that
      // Dexie live-query observers never see a frame with neither event.
      const eventToStore = carriedConversationId
        ? {
            ...newEvent,
            payload: { ...(newEvent.payload as Record<string, unknown>), conversationId: carriedConversationId },
          }
        : newEvent
      await db.events.put({
        ...eventToStore,
        workspaceId,
        _sequenceNum: sequenceToNum(newEvent.sequence),
        _cachedAt: now,
      })

      if (newPayload.clientMessageId) {
        await db.events.delete(newPayload.clientMessageId).catch(() => {})
        await db.pendingMessages.delete(newPayload.clientMessageId).catch(() => {})
      }
    })

    if (gapAfterSequence !== null) {
      onSequenceGap?.({ streamId, afterSequence: gapAfterSequence })
    }

    // Seed the decrypt cache so the encrypted server event renders its content
    // immediately. Only meaningful for E2E events (the wire payload carries a
    // ciphertext); for plaintext sends the render path ignores the cache.
    if (optimisticPlaintext && isEncryptedPayload(newEvent.payload)) {
      seedDecryption(newEvent.id, optimisticPlaintext)
    }

    // Update sidebar preview in both TanStack cache and IDB so the sort order
    // and preview text survive cold starts (offline-first).
    const newPreview: LastMessagePreview = {
      authorId: newEvent.actorId ?? "",
      authorType: newEvent.actorType ?? "user",
      content: newPayload.contentJson as string,
      createdAt: newEvent.createdAt,
    }

    await db.streams.update(streamId, {
      lastMessagePreview: newPreview,
      _cachedAt: Date.now(),
    })

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      return {
        ...old,
        streams: old.streams.map((stream) => {
          if (stream.id !== streamId) return stream
          return { ...stream, lastMessagePreview: newPreview }
        }),
      }
    })

    // If the new event includes a sharedMessage pointer, the cached bootstrap's
    // sharedMessages hydration map won't contain an entry for the source yet —
    // without a refetch the pointer renders with no content. Invalidate so the
    // next response populates the hydration map.
    if (contentHasSharedMessage(newPayload.contentJson)) {
      await queryClient.invalidateQueries({ queryKey: streamKeys.bootstrap(workspaceId, streamId) })
      await queryClient.invalidateQueries({ queryKey: streamKeys.events(workspaceId, streamId) })
    }
  }

  const handleMessageEdited = async (payload: MessageEventPayload) => {
    if (payload.streamId !== streamId) return
    const editEvent = payload.event
    const editPayload = editEvent.payload as {
      messageId: string
      contentJson: unknown
      contentMarkdown: string
    }

    await updateMessageEvent(streamId, editPayload.messageId, (p) => ({
      ...p,
      contentJson: editPayload.contentJson,
      contentMarkdown: editPayload.contentMarkdown,
      editedAt: editEvent.createdAt,
    }))

    if (contentHasSharedMessage(editPayload.contentJson)) {
      await queryClient.invalidateQueries({ queryKey: streamKeys.bootstrap(workspaceId, streamId) })
      await queryClient.invalidateQueries({ queryKey: streamKeys.events(workspaceId, streamId) })
    }
  }

  const handleMessageDeleted = async (payload: MessageDeletedPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => ({
      ...p,
      deletedAt: payload.deletedAt,
    }))

    // Fix A2: the delete transaction marks the message's activity rows read
    // server-side with no counter event, so drop the held rows here to match.
    commitCounterMutation(queryClient, workspaceId, (s) => dropMessageActivities(s, payload.messageId))
  }

  const handleMessagesMoved = async (payload: MessagesMovedPayload) => {
    if (payload.sourceStreamId !== streamId && payload.destinationStreamId !== streamId) return

    const now = Date.now()
    await db.transaction("rw", [db.events, db.streams], async () => {
      if (payload.sourceStreamId === streamId) {
        await db.events.bulkDelete(payload.removedEventIds)
        // Append the source tombstone after the deletes so the timeline
        // shows a "moved 3 messages → thread" trace where the messages
        // used to be. The event was assigned a fresh sequence in the
        // source stream so it sorts naturally at the bottom of the
        // post-move state.
        await db.events.put({
          ...payload.sourceTombstoneEvent,
          workspaceId,
          _sequenceNum: sequenceToNum(payload.sourceTombstoneEvent.sequence),
          _cachedAt: now,
        })
        // SET replyCount + threadSummary directly from the payload (not
        // additive) so the patch is idempotent against the sibling
        // `message:updated` event — they carry the same authoritative
        // values, and whichever arrives second just overwrites with the
        // identical result. This makes `messages:moved` self-sufficient:
        // the thread card surfaces with the right count even if
        // `message:updated` is delayed or lost.
        await updateMessageEvent(streamId, payload.targetMessageId, (p) => ({
          ...p,
          threadId: payload.thread.id,
          replyCount: payload.parentReplyCount,
          threadSummary: payload.parentThreadSummary,
        }))
      }

      if (payload.destinationStreamId === streamId) {
        await db.events.bulkPut(
          payload.events.map((event) => ({
            ...event,
            workspaceId,
            _sequenceNum: sequenceToNum(event.sequence),
            _cachedAt: now,
          }))
        )
      }

      const streamUpdate = { ...payload.thread, _cachedAt: now }
      const updated = await db.streams.update(payload.thread.id, streamUpdate)
      if (updated === 0) {
        await db.streams.put(streamUpdate)
      }
    })

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const streamExists = old.streams.some((stream) => stream.id === payload.thread.id)
      return {
        ...old,
        streams: streamExists
          ? old.streams.map((stream) =>
              stream.id === payload.thread.id
                ? { ...stream, ...payload.thread, lastMessagePreview: stream.lastMessagePreview }
                : stream
            )
          : [...old.streams, { ...payload.thread, lastMessagePreview: null }],
      }
    })

    // Re-home held activity rows from the source stream to the destination (D4):
    // the server UPDATEs user_activity.stream_id on a move with no counter event.
    // This handler fires once per subscribed stream (source AND destination), so
    // gate on the source to apply the workspace-wide rehome exactly once. Fix A1:
    // the same gate SETs the source's latest ordinal to its post-move count so
    // the phantom unread from vacated `message_created` rows heals.
    if (payload.sourceStreamId === streamId) {
      commitCounterMutation(queryClient, workspaceId, (s) =>
        rehomeActivities(s, payload.sourceStreamId, payload.destinationStreamId, payload.movedMessageIds)
      )
      if (payload.sourceMessageOrdinal !== undefined) {
        const sourceOrdinal = payload.sourceMessageOrdinal
        commitCounterMutation(queryClient, workspaceId, (s) =>
          applyMovedSourceOrdinal(s, payload.sourceStreamId, sourceOrdinal, payload.movedMessageIds)
        )
      }
    }
  }

  const handleReactionAdded = async (payload: ReactionPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => {
      const reactions = { ...((p.reactions as Record<string, string[]>) ?? {}) }
      const existing = reactions[payload.emoji] || []
      if (!existing.includes(payload.userId)) {
        reactions[payload.emoji] = [...existing, payload.userId]
      }
      return { ...p, reactions }
    })
  }

  const handleReactionRemoved = async (payload: ReactionPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => {
      const reactions = { ...((p.reactions as Record<string, string[]>) ?? {}) }
      if (reactions[payload.emoji]) {
        reactions[payload.emoji] = reactions[payload.emoji].filter((id) => id !== payload.userId)
        if (reactions[payload.emoji].length === 0) {
          delete reactions[payload.emoji]
        }
      }
      return { ...p, reactions }
    })

    // Drop the held activity row this reaction produced (D4): the server deleted
    // the user_activity row without a counter event, so the derived activity/
    // mention counts fall to match the feed without a separate emit.
    commitCounterMutation(queryClient, workspaceId, (s) =>
      dropReactionActivity(s, { messageId: payload.messageId, actorId: payload.userId, emoji: payload.emoji })
    )
  }

  const handleStreamCreated = async (payload: StreamCreatedPayload) => {
    if (payload.streamId !== streamId) return
    const stream = payload.stream
    if (!stream.parentMessageId) return

    await updateMessageEvent(streamId, stream.parentMessageId, (p) => ({
      ...p,
      threadId: stream.id,
    }))

    await db.streams.put({ ...stream, _cachedAt: Date.now() })

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const streamExists = old.streams.some((existing) => existing.id === stream.id)
      return {
        ...old,
        streams: streamExists
          ? old.streams.map((existing) =>
              existing.id === stream.id
                ? { ...existing, ...stream, lastMessagePreview: existing.lastMessagePreview }
                : existing
            )
          : [...old.streams, { ...stream, lastMessagePreview: null }],
      }
    })
  }

  const handleMessageUpdated = async (payload: MessageUpdatedPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => {
      if (payload.updateType === "reply_count" && payload.replyCount !== undefined) {
        // threadSummary is only present when the backend recomputed one; leave
        // the previous value untouched if the field is absent (older servers).
        // `null` is a meaningful value (last reply was deleted) so we only
        // skip the patch when the field is `undefined`.
        const next: Record<string, unknown> = { ...p, replyCount: payload.replyCount }
        if (payload.threadSummary !== undefined) {
          next.threadSummary = payload.threadSummary
        }
        // A truthy threadId makes the patch self-sufficient for the thread
        // card when stream:created was missed. `null` (thread gone) is left
        // alone — replyCount 0 already hides the card.
        if (payload.threadId) {
          next.threadId = payload.threadId
        }
        return next
      }
      if (payload.updateType === "content" && payload.contentMarkdown !== undefined) {
        return { ...p, contentMarkdown: payload.contentMarkdown }
      }
      return p
    })
  }

  const handleAppendEvent = async (
    payload:
      | AgentSessionEventPayload
      | CommandEventPayload
      | MemberRemovedPayload
      | MemosCapturedPayload
      | StreamLifecycleEventPayload
      | DescriptionSetPayload
  ) => {
    if (payload.streamId !== streamId) return
    const now = Date.now()
    // Set when this event's sequence reveals missed events behind it; reported
    // after the transaction commits so the backfill never runs inside it.
    let gapAfterSequence: string | null = null
    // Same transactional shape as handleMessageCreated: dedupe, gap-read, and
    // put must be atomic, or a concurrent append can land between the gap read
    // and this write and make the cursor lie in either direction.
    await db.transaction("rw", [db.events], async () => {
      const existing = await db.events.get(payload.event.id)
      if (existing) return
      // Tail-gap check must read the latest BEFORE this write advances it.
      if (onSequenceGap) {
        gapAfterSequence = detectSequenceGap(await getPersistedTail(streamId), payload.event)
      }
      await db.events.put({
        ...payload.event,
        workspaceId,
        _sequenceNum: sequenceToNum(payload.event.sequence),
        _cachedAt: now,
      })
    })
    if (gapAfterSequence !== null) {
      onSequenceGap?.({ streamId, afterSequence: gapAfterSequence })
    }
  }

  // Call started/ended append to the timeline like any broadcast/patch event
  // (call_started is the slotted card; call_ended is the patch carrying the end
  // summary). The stream:call_started/ended events also update the active-calls
  // store, but that runs in workspace-sync (which owns the store from the
  // workspace/user-room fan-out that reaches the sidebar); here we only append
  // the row so the card renders in the timeline.
  //
  // call:participants_changed is stream-scoped and carries NO timeline row — it
  // only refreshes the live card's roster in the active-calls store.
  const handleCallParticipantsChanged = (payload: {
    streamId: string
    callId: string
    participantCount: number
    participantUserIds: string[]
  }) => {
    if (payload.streamId !== streamId) return
    updateCallParticipants(workspaceId, {
      callId: payload.callId,
      streamId: payload.streamId,
      participantCount: payload.participantCount,
      participantUserIds: payload.participantUserIds,
    })
  }

  // Delegation events append to the timeline like any broadcast/patch event,
  // and additionally refresh the authoritative list behind the "In this
  // stream" panel (statuses live in these patches, so the list query is the
  // only view that stays correct outside the loaded window). Invalidation
  // refetches only while the panel has the query mounted; otherwise it just
  // marks stale.
  const handleDelegationEvent = async (payload: Parameters<typeof handleAppendEvent>[0]) => {
    if (payload.streamId !== streamId) return
    await handleAppendEvent(payload)
    await queryClient.invalidateQueries({ queryKey: delegationKeys.stream(workspaceId, streamId) })
  }

  const handleLinkPreviewReady = async (payload: LinkPreviewReadyPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => ({
      ...p,
      linkPreviews: preserveBakedInAppData(payload.previews, p.linkPreviews as LinkPreviewSummary[] | undefined),
    }))
  }

  /**
   * Invalidate any TanStack Query cache holding this stream's messages when
   * a pointer-referenced source message in another stream is edited or
   * deleted. Triggers a refetch so the hydrated share-map on the next
   * response reflects the new content. The payload's targetStreamId is the
   * room this emit was scoped to, so we just invalidate bootstrap/events.
   */
  const handlePointerInvalidated = async (payload: { targetStreamId: string; sourceMessageId: string }) => {
    if (payload.targetStreamId !== streamId) return
    await queryClient.invalidateQueries({ queryKey: streamKeys.bootstrap(workspaceId, streamId) })
    await queryClient.invalidateQueries({ queryKey: streamKeys.events(workspaceId, streamId) })
  }

  // Bot runtime presence updates fan out to every stream room the bot is a
  // member of. Patch the cached bootstrap so any open scratchpad showing the
  // status strip re-renders without a refetch.
  //
  // `lastSeenAt` is intentionally excluded from the equality check — Pi runtimes
  // touch presence on every poll/step (multiple times per second during active
  // sessions), but the UI only renders `status`, `statusText`, and
  // `displayName`. Including `lastSeenAt` here forced the bootstrap cache to
  // patch on every heartbeat, which cascaded into a full StreamContent
  // re-render (and the heavy composer subtree with it) and made typing on
  // mobile feel laggy whenever a bot was active.
  const handleBotRuntimePresence = (payload: {
    workspaceId: string
    streamId: string
    botId: string
    presence: BotRuntimePresenceSummary | null
  }) => {
    if (payload.streamId !== streamId) return
    // The stream's effective command set follows runtime liveness: a runtime
    // coming online adds its session-control commands (/steer, /stop, /model…),
    // one going away removes them. `commands` was computed server-side at
    // bootstrap time, so on a liveness edge refresh it — otherwise a scratchpad
    // opened before its agent connected keeps an empty slash menu until the
    // next full bootstrap. Available↔busy flips (every turn) don't change the
    // set and must not trigger refetches.
    let commandsAffected = false
    queryClient.setQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId), (old) => {
      if (!old) return old
      const current = old.botRuntimePresence ?? {}
      const previous = current[payload.botId] ?? null
      const next = payload.presence
      if (
        previous?.status === next?.status &&
        previous?.statusText === next?.statusText &&
        previous?.displayName === next?.displayName &&
        previous?.acceptingInvocations === next?.acceptingInvocations &&
        previous?.runtimeKind === next?.runtimeKind &&
        previous?.instanceId === next?.instanceId
      ) {
        return old
      }
      commandsAffected = commandsLive(previous) !== commandsLive(next) || previous?.instanceId !== next?.instanceId
      return {
        ...old,
        botRuntimePresence: { ...current, [payload.botId]: next },
      }
    })
    if (commandsAffected) void refreshStreamCommands()
  }

  const refreshStreamCommands = async () => {
    try {
      const commands = await commandsApi.listForStream(workspaceId, streamId)
      queryClient.setQueryData<CachedStreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId), (old) =>
        old ? { ...old, commands } : old
      )
    } catch {
      // Best-effort freshness — the next bootstrap converges the command set.
    }
  }

  socket.on("message:created", handleMessageCreated)
  socket.on("message:edited", handleMessageEdited)
  socket.on("message:deleted", handleMessageDeleted)
  socket.on("messages:moved", handleMessagesMoved)
  socket.on("reaction:added", handleReactionAdded)
  socket.on("reaction:removed", handleReactionRemoved)
  socket.on("stream:created", handleStreamCreated)
  socket.on("message:updated", handleMessageUpdated)
  socket.on("stream:member_joined", handleAppendEvent)
  socket.on("stream:member_added", handleAppendEvent)
  socket.on("stream:member_removed", handleAppendEvent)
  socket.on("command:dispatched", handleAppendEvent)
  socket.on("command:completed", handleAppendEvent)
  socket.on("command:failed", handleAppendEvent)
  socket.on("agent_session:started", handleAppendEvent)
  socket.on("agent_session:completed", handleAppendEvent)
  socket.on("agent_session:failed", handleAppendEvent)
  socket.on("agent_session:interrupted", handleAppendEvent)
  socket.on("agent_session:deleted", handleAppendEvent)
  socket.on("stream:memos_captured", handleAppendEvent)
  socket.on("stream:agent_follow_up_scheduled", handleAppendEvent)
  socket.on("stream:agent_follow_up_cancelled", handleAppendEvent)
  socket.on("stream:delegation_created", handleDelegationEvent)
  socket.on("stream:delegation_status_changed", handleDelegationEvent)
  // Bot-access request/resolution rows append to the timeline like any other
  // broadcast/patch event; there is no list hook behind them (the card renders
  // from the payload snapshot + the in-window status patch), so a plain append
  // is all that's needed.
  socket.on("stream:bot_access_requested", handleAppendEvent)
  socket.on("stream:bot_access_status_changed", handleAppendEvent)
  socket.on("stream:brief_updated", handleAppendEvent)
  socket.on("stream:call_started", handleAppendEvent)
  socket.on("stream:call_ended", handleAppendEvent)
  socket.on("call:participants_changed", handleCallParticipantsChanged)
  socket.on("stream:archived", handleAppendEvent)
  socket.on("stream:unarchived", handleAppendEvent)
  socket.on("stream:description_set", handleAppendEvent)
  socket.on("link_preview:ready", handleLinkPreviewReady)
  socket.on("pointer:invalidated", handlePointerInvalidated)
  socket.on("bot_runtime:presence", handleBotRuntimePresence)

  return () => {
    socket.off("message:created", handleMessageCreated)
    socket.off("message:edited", handleMessageEdited)
    socket.off("message:deleted", handleMessageDeleted)
    socket.off("messages:moved", handleMessagesMoved)
    socket.off("reaction:added", handleReactionAdded)
    socket.off("reaction:removed", handleReactionRemoved)
    socket.off("stream:created", handleStreamCreated)
    socket.off("message:updated", handleMessageUpdated)
    socket.off("stream:member_joined", handleAppendEvent)
    socket.off("stream:member_added", handleAppendEvent)
    socket.off("stream:member_removed", handleAppendEvent)
    socket.off("command:dispatched", handleAppendEvent)
    socket.off("command:completed", handleAppendEvent)
    socket.off("command:failed", handleAppendEvent)
    socket.off("agent_session:started", handleAppendEvent)
    socket.off("agent_session:completed", handleAppendEvent)
    socket.off("agent_session:failed", handleAppendEvent)
    socket.off("agent_session:interrupted", handleAppendEvent)
    socket.off("agent_session:deleted", handleAppendEvent)
    socket.off("stream:memos_captured", handleAppendEvent)
    socket.off("stream:agent_follow_up_scheduled", handleAppendEvent)
    socket.off("stream:agent_follow_up_cancelled", handleAppendEvent)
    socket.off("stream:delegation_created", handleDelegationEvent)
    socket.off("stream:delegation_status_changed", handleDelegationEvent)
    socket.off("stream:bot_access_requested", handleAppendEvent)
    socket.off("stream:bot_access_status_changed", handleAppendEvent)
    socket.off("stream:brief_updated", handleAppendEvent)
    socket.off("stream:call_started", handleAppendEvent)
    socket.off("stream:call_ended", handleAppendEvent)
    socket.off("call:participants_changed", handleCallParticipantsChanged)
    socket.off("stream:archived", handleAppendEvent)
    socket.off("stream:unarchived", handleAppendEvent)
    socket.off("stream:description_set", handleAppendEvent)
    socket.off("link_preview:ready", handleLinkPreviewReady)
    socket.off("pointer:invalidated", handlePointerInvalidated)
    socket.off("bot_runtime:presence", handleBotRuntimePresence)
  }
}
