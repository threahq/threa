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
import type { Socket } from "socket.io-client"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import type { QueryClient } from "@tanstack/react-query"

// ============================================================================
// Bootstrap application — writes stream bootstrap data to IndexedDB
// ============================================================================

export interface CachedStreamBootstrap extends StreamBootstrap {
  windowVersion: number
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
    .filter((event) => event._status !== "pending" && event._status !== "failed")
    .first()

  return latestEvent?.sequence ?? null
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

    const toWrite: CachedEvent[] = []
    for (const e of bootstrap.events) {
      const base = { ...e, workspaceId, _sequenceNum: sequenceToNum(e.sequence), _cachedAt: now }
      if (e.eventType !== "message_created") {
        toWrite.push(base)
        continue
      }
      const existing = existingById.get(e.id)
      if (!existing) {
        toWrite.push(base)
        continue
      }
      if (snapshotMs !== null && existing._patchedAt !== undefined && existing._patchedAt > snapshotMs) {
        // Skip the put — existing row is fresher than this snapshot.
        continue
      }
      toWrite.push({
        ...base,
        payload: {
          ...(existing.payload as Record<string, unknown>),
          ...(e.payload as Record<string, unknown>),
        },
        // Preserve the patch watermark so subsequent bootstraps still see
        // that this row has been touched by socket activity.
        _patchedAt: existing._patchedAt,
      })
    }

    if (toWrite.length > 0) {
      await db.events.bulkPut(toWrite)
    }
  }

  // Merge stream metadata without destroying fields that only exist on the
  // workspace bootstrap's StreamWithPreview (e.g. lastMessagePreview, which
  // is the sidebar's activity sort key). Use update() for existing records
  // and fall back to put() if the stream doesn't exist in IDB yet.
  const stream = preserveDmDisplayName(bootstrap.stream)
  const fullStreamData = {
    ...stream,
    pinned: bootstrap.membership?.pinned,
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
}

/**
 * Same as `applyStreamBootstrap` but written for callers that have already
 * opened a `db.transaction` — it just delegates to `writeBootstrapEventsAndStream`.
 */
export async function applyStreamBootstrapInCurrentTransaction(
  workspaceId: string,
  streamId: string,
  bootstrap: StreamBootstrap,
  now = Date.now()
): Promise<void> {
  await writeBootstrapEventsAndStream(workspaceId, streamId, bootstrap, now)
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

interface LinkPreviewReadyPayload {
  workspaceId: string
  streamId: string
  messageId: string
  previews: LinkPreviewSummary[]
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

export function registerStreamSocketHandlers(
  socket: Socket,
  workspaceId: string,
  streamId: string,
  queryClient: QueryClient
): () => void {
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

    await db.transaction("rw", [db.events, db.pendingMessages], async () => {
      // Dedupe by event ID
      const existing = await db.events.get(newEvent.id)
      if (existing) return

      // Add the real event BEFORE deleting the optimistic one so that
      // Dexie live-query observers never see a frame with neither event.
      await db.events.put({ ...newEvent, workspaceId, _sequenceNum: sequenceToNum(newEvent.sequence), _cachedAt: now })

      // Now remove the optimistic event, keyed by the client id the server echoes back.
      if (newPayload.clientMessageId) {
        const optimistic = await db.events.get(newPayload.clientMessageId)
        optimisticPlaintext = readPlaintextContent(optimistic?.payload)
        await db.events.delete(newPayload.clientMessageId).catch(() => {})
        await db.pendingMessages.delete(newPayload.clientMessageId).catch(() => {})
      }
    })

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
        return next
      }
      if (payload.updateType === "content" && payload.contentMarkdown !== undefined) {
        return { ...p, contentMarkdown: payload.contentMarkdown }
      }
      return p
    })
  }

  const handleAppendEvent = async (payload: AgentSessionEventPayload | CommandEventPayload | MemberRemovedPayload) => {
    if (payload.streamId !== streamId) return
    const now = Date.now()
    // Dedupe by event ID
    const existing = await db.events.get(payload.event.id)
    if (existing) return
    await db.events.put({
      ...payload.event,
      workspaceId,
      _sequenceNum: sequenceToNum(payload.event.sequence),
      _cachedAt: now,
    })
  }

  const handleLinkPreviewReady = async (payload: LinkPreviewReadyPayload) => {
    if (payload.streamId !== streamId) return
    await updateMessageEvent(streamId, payload.messageId, (p) => ({
      ...p,
      linkPreviews: payload.previews,
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
      return {
        ...old,
        botRuntimePresence: { ...current, [payload.botId]: next },
      }
    })
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
  socket.on("agent_session:deleted", handleAppendEvent)
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
    socket.off("agent_session:deleted", handleAppendEvent)
    socket.off("link_preview:ready", handleLinkPreviewReady)
    socket.off("pointer:invalidated", handlePointerInvalidated)
    socket.off("bot_runtime:presence", handleBotRuntimePresence)
  }
}
