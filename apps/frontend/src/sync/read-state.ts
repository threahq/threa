import type { QueryClient } from "@tanstack/react-query"
import type { StreamBootstrap, StreamReadFrontier, StreamReadFrontierSnapshot, WorkspaceBootstrap } from "@threa/types"
import { db, type CachedStreamReadState } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import { applyStreamReadMessages, applyStreamsReadAllOrdinals, dropMessageActivities } from "./unread-counters"
import { applyCountersToCache, putCountersIdb, type CounterMutator } from "./catch-up-batch"
import { effectiveFreshness } from "./bootstrap-diff"

/**
 * Upsert the read-frontier row in IDB — the sole read watermark. Runs inside the
 * caller's `rw` transaction. Row presence is authoritative for frontier readers.
 */
export async function putReadStateIdb(
  workspaceId: string,
  streamId: string,
  fields: StreamReadFrontier,
  now = Date.now()
): Promise<void> {
  await db.streamReadState.put({
    id: `${workspaceId}:${streamId}`,
    workspaceId,
    streamId,
    lastReadEventId: fields.lastReadEventId,
    lastReadSequence: fields.lastReadSequence,
    lastReadAt: fields.lastReadAt,
    _cachedAt: now,
  })
}

/** The frontier fields of a cached read-state row (drops the IDB bookkeeping). */
export function toStreamReadFrontier(row: CachedStreamReadState): StreamReadFrontier {
  return {
    lastReadEventId: row.lastReadEventId,
    lastReadSequence: row.lastReadSequence,
    lastReadAt: row.lastReadAt,
  }
}

/**
 * True when the stream's standalone frontier row was written at/after `since` —
 * a socket/live write (the caller's own request echo, or a later action) that
 * postdates the caller's operation. The per-stream read-state `_cachedAt` is
 * the touched stamp the workspace-bootstrap freshness merge keys off (every
 * applier in this module stamps it via `putReadStateIdb` /
 * `writeSnapshotWatermarkIdb`): an HTTP response that observes a touched stream
 * must not apply there — the snapshot may predate an explicit unread, a
 * sanctioned downward move no max(sequence) rule can protect. Operation order
 * (touched-at) decides, not sequence max.
 */
export async function readStateTouchedSince(workspaceId: string, streamId: string, since: number): Promise<boolean> {
  const row = await db.streamReadState.get(`${workspaceId}:${streamId}`)
  if (row === undefined) return false
  return effectiveFreshness(workspaceId, "streamReadState", row.id, row._cachedAt) >= since
}

/** Merge one stream's standalone frontier into the workspace bootstrap query cache. */
export function mergeReadStateIntoBootstrapCache(
  queryClient: QueryClient,
  workspaceId: string,
  streamId: string,
  fields: StreamReadFrontier
): void {
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    return {
      ...old,
      streamReadState: { ...(old.streamReadState ?? {}), [streamId]: fields },
    }
  })
}

/**
 * The absolute post-write read state for one stream produced by a sparse-read
 * write (`stream:read_messages` socket echo, or a conversation-surface optimistic
 * apply). `readMessageIds` is the ENTIRE overlay for that (stream, member) after
 * the write (post-compaction) — absolute, not a delta — so application is
 * idempotent and order-convergent. See docs/sparse-read-overlay-design.md.
 */
export interface ReadStateSnapshot {
  streamId: string
  readMessageIds: string[]
  lastReadEventId: string | null
  lastReadSequence: string
  lastReadOrdinal: number
  /** The ids this write marked read (pre-compaction) — set on the read path
   * only. Their held activity rows (mention/reply badges) drop on apply:
   * message-granular, so the stream's other topics keep their badges. */
  markedMessageIds?: string[]
}

/** The pure counter fold for one snapshot — the single math authority both the
 *  socket echo and the optimistic apply route through. */
export function snapshotCounterMutator(snapshot: ReadStateSnapshot): CounterMutator {
  return (state) => {
    let next = applyStreamReadMessages(state, snapshot.streamId, {
      readMessageIds: snapshot.readMessageIds,
      lastReadOrdinal: snapshot.lastReadOrdinal,
    })
    for (const messageId of snapshot.markedMessageIds ?? []) {
      next = dropMessageActivities(next, messageId)
    }
    return next
  }
}

/** Mirror a snapshot's frontier into the query cache (workspace streamReadState
 *  map + per-stream bootstrap readState) so the unread divider tracks
 *  immediately. */
function mirrorSnapshotToCache(queryClient: QueryClient, workspaceId: string, snapshot: ReadStateSnapshot): void {
  const frontier: StreamReadFrontier = {
    lastReadEventId: snapshot.lastReadEventId,
    lastReadSequence: snapshot.lastReadSequence,
    lastReadAt: new Date().toISOString(),
  }

  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    return {
      ...old,
      streamReadState: { ...(old.streamReadState ?? {}), [snapshot.streamId]: frontier },
    }
  })

  queryClient.setQueryData<StreamBootstrap | undefined>(streamKeys.bootstrap(workspaceId, snapshot.streamId), (old) => {
    if (!old) return old
    return { ...old, readState: frontier }
  })
}

/** Write a snapshot's frontier to IDB. Must run inside an open `rw` transaction
 *  that includes `db.streamReadState`. */
async function writeSnapshotWatermarkIdb(workspaceId: string, snapshot: ReadStateSnapshot): Promise<void> {
  await putReadStateIdb(
    workspaceId,
    snapshot.streamId,
    {
      lastReadEventId: snapshot.lastReadEventId,
      lastReadSequence: snapshot.lastReadSequence,
      lastReadAt: new Date().toISOString(),
    },
    Date.now()
  )
}

/**
 * THE single apply path for a sparse-read snapshot on the socket side: mirror
 * the watermark into the query cache, fold the counter through the caller's
 * commit (batch-aware during catch-up, immediate live), and persist the
 * watermark mirrors to IDB. The counter's own IDB write (`db.unreadState`) is
 * owned by `commitCounter`; the watermark mirror is a separate transaction, as
 * with the other read handlers.
 */
export function commitReadStateSnapshot(
  queryClient: QueryClient,
  workspaceId: string,
  snapshot: ReadStateSnapshot,
  commitCounter: (mutate: CounterMutator) => void
): void {
  mirrorSnapshotToCache(queryClient, workspaceId, snapshot)
  commitCounter(snapshotCounterMutator(snapshot))
  void db.transaction("rw", [db.streamReadState], () => writeSnapshotWatermarkIdb(workspaceId, snapshot))
}

/**
 * Optimistic apply of one or more snapshots straight to IDB (no query cache):
 * the badge (`db.unreadState`), the timeline overlay, and the board card read
 * state all read IDB via `useLiveQuery`, so this drives the live UI instantly.
 * The authoritative `stream:read_messages` echo reconciles the query cache
 * through `commitReadStateSnapshot`. Counter math + watermark persistence share
 * the same helpers as the socket path (`snapshotCounterMutator`,
 * `writeSnapshotWatermarkIdb`), so there is one apply path per surface (INV-35).
 *
 * `startedAt` (the mutation's departure time) activates the per-stream
 * touched-at guard: a leg whose frontier row was written at/after `startedAt`
 * was touched by this request's own socket echo or a later action (e.g. an
 * explicit unread over a delayed read), so this stale response skips that leg
 * entirely — no old overlay SET, no frontier regression. Per stream, because a
 * conversation spans root + thread legs that move independently. The server's
 * socket log stays canonical; the echo (or the later action's echo) owns the
 * touched leg.
 */
export async function applyReadStateSnapshotsIdb(
  workspaceId: string,
  snapshots: ReadStateSnapshot[],
  startedAt?: number
): Promise<void> {
  if (snapshots.length === 0) return
  await db.transaction("rw", [db.unreadState, db.streamReadState], async () => {
    let effective = snapshots
    if (startedAt !== undefined) {
      effective = []
      for (const snapshot of snapshots) {
        if (await readStateTouchedSince(workspaceId, snapshot.streamId, startedAt)) continue
        effective.push(snapshot)
      }
      if (effective.length === 0) return
    }
    const mutators = effective.map(snapshotCounterMutator)
    await putCountersIdb(workspaceId, mutators)
    for (const snapshot of effective) {
      await writeSnapshotWatermarkIdb(workspaceId, snapshot)
    }
  })
}

/** One read-all frontier resolved to the canonical highest of every source. */
export interface ResolvedReadAllFrontier {
  streamId: string
  frontier: StreamReadFrontier
}

function frontierSequence(frontier: StreamReadFrontier): bigint | null {
  return frontier.lastReadSequence != null ? BigInt(frontier.lastReadSequence) : null
}

/**
 * Resolve each incoming mark-all snapshot (the additive `frontiers` field on
 * the HTTP response and the `stream:read_all` socket payload) to ONE canonical
 * frontier — the highest sequence across the incoming snapshot, the workspace
 * bootstrap cache, the loaded per-stream bootstrap cache, and the persisted
 * `db.streamReadState` row. Mark-all is advance-only, and the SAME canonical
 * frontier is then written back to every surface (publishReadAllFrontiersToCache
 * + putReadAllFrontiersIdb), so stale memory can never linger below a persisted
 * row while the IDB write is skipped.
 *
 * Row presence/null semantics: an ABSENT source contributes no candidate (no
 * fabricated frontier); a PRESENT null sequence is a real pre-first-message
 * frontier that any real sequence beats. Ties break deterministically by
 * source order — persisted IDB first, incoming last — and the fold replaces
 * only on a STRICTLY greater sequence, so an equal sequence keeps the more
 * durable row. Must run inside the caller's `rw` transaction that includes
 * `db.streamReadState` (or standalone before the write transaction opens) so
 * the resolution and the write see the same table state.
 *
 * A missing/empty snapshot list (legacy payload from before the field shipped)
 * resolves to nothing: existing rows stay put and the next bootstrap
 * reconciles — never delete or regress on an absent field.
 */
export async function resolveReadAllFrontiers(
  queryClient: QueryClient,
  workspaceId: string,
  frontiers: StreamReadFrontierSnapshot[] | undefined
): Promise<ResolvedReadAllFrontier[]> {
  if (!frontiers || frontiers.length === 0) return []

  const now = new Date().toISOString()
  const workspaceMap =
    queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))?.streamReadState ?? {}

  const idbRows = await db.streamReadState.bulkGet(frontiers.map((snapshot) => `${workspaceId}:${snapshot.streamId}`))
  const resolved: ResolvedReadAllFrontier[] = []
  for (const [index, snapshot] of frontiers.entries()) {
    // Candidates in fixed source order: persisted IDB, per-stream bootstrap
    // cache, workspace bootstrap cache, then the incoming snapshot.
    const candidates: StreamReadFrontier[] = []
    const idbRow = idbRows[index]
    if (idbRow) {
      candidates.push({
        lastReadEventId: idbRow.lastReadEventId,
        lastReadSequence: idbRow.lastReadSequence,
        lastReadAt: idbRow.lastReadAt,
      })
    }
    const perStream = queryClient.getQueryData<StreamBootstrap | undefined>(
      streamKeys.bootstrap(workspaceId, snapshot.streamId)
    )?.readState
    if (perStream) candidates.push(perStream)
    const workspaceFrontier = workspaceMap[snapshot.streamId]
    if (workspaceFrontier) candidates.push(workspaceFrontier)
    candidates.push({
      lastReadEventId: snapshot.lastReadEventId,
      lastReadSequence: snapshot.lastReadSequence,
      lastReadAt: snapshot.lastReadAt ?? now,
    })

    let canonical = candidates[0]
    let canonicalSeq = frontierSequence(canonical)
    for (const candidate of candidates.slice(1)) {
      const candidateSeq = frontierSequence(candidate)
      if (candidateSeq != null && (canonicalSeq == null || candidateSeq > canonicalSeq)) {
        canonical = candidate
        canonicalSeq = candidateSeq
      }
    }
    resolved.push({ streamId: snapshot.streamId, frontier: canonical })
  }
  return resolved
}

/** Write resolved canonical frontier rows to IDB. Must run inside an open `rw`
 *  transaction that includes `db.streamReadState`. */
export async function putReadAllFrontiersIdb(workspaceId: string, resolved: ResolvedReadAllFrontier[]): Promise<void> {
  if (resolved.length === 0) return
  const cachedAt = Date.now()
  await db.streamReadState.bulkPut(
    resolved.map(({ streamId, frontier }) => ({
      id: `${workspaceId}:${streamId}`,
      workspaceId,
      streamId,
      lastReadEventId: frontier.lastReadEventId,
      lastReadSequence: frontier.lastReadSequence,
      lastReadAt: frontier.lastReadAt,
      _cachedAt: cachedAt,
    }))
  )
}

/** Publish resolved frontiers to the in-memory caches: the workspace bootstrap
 *  `streamReadState` map (single set for the whole batch) and each loaded
 *  per-stream bootstrap's `readState` (the open conversation's divider). Call
 *  only AFTER the matching IDB write succeeded, so the caches never publish a
 *  frontier the persisted store lacks. */
export function publishReadAllFrontiersToCache(
  queryClient: QueryClient,
  workspaceId: string,
  resolved: ResolvedReadAllFrontier[]
): void {
  if (resolved.length === 0) return

  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    const merged = { ...(old.streamReadState ?? {}) }
    for (const { streamId, frontier } of resolved) merged[streamId] = frontier
    return { ...old, streamReadState: merged }
  })

  for (const { streamId, frontier } of resolved) {
    queryClient.setQueryData<StreamBootstrap | undefined>(streamKeys.bootstrap(workspaceId, streamId), (old) =>
      old ? { ...old, readState: frontier } : old
    )
  }
}

/**
 * THE single live (non-batched) read-all apply path — the `stream:read_all`
 * socket handler routes here. Persists the counter fold (absolute read
 * positions + overlay clearing) and the canonical frontier rows in ONE
 * transaction over `db.unreadState` + `db.streamReadState`, resolving the
 * frontiers INSIDE that transaction so the canonical pick and the write see the
 * same table state; the in-memory publication (counters + frontiers) happens
 * only after the transaction commits, so a failed transaction publishes nothing
 * the IDB lacks. During catch-up the batch owns the same atomicity
 * (`CatchUpBatch.applyReadAllFrontiers` / `flush`).
 *
 * A legacy payload without frontiers keeps the legacy counter behavior and
 * touches no frontier rows — the transaction then covers `db.unreadState`
 * alone (atomic over exactly the tables it touches).
 */
export async function commitReadAll(
  queryClient: QueryClient,
  workspaceId: string,
  reads: Array<{ streamId: string; lastReadOrdinal: number }>,
  frontiers: StreamReadFrontierSnapshot[] | undefined
): Promise<void> {
  const mutators: CounterMutator[] = [(state) => applyStreamsReadAllOrdinals(state, reads)]
  const haveFrontiers = Boolean(frontiers && frontiers.length > 0)

  let resolved: ResolvedReadAllFrontier[] = []
  await db.transaction("rw", haveFrontiers ? [db.unreadState, db.streamReadState] : [db.unreadState], async () => {
    await putCountersIdb(workspaceId, mutators)
    if (haveFrontiers) {
      resolved = await resolveReadAllFrontiers(queryClient, workspaceId, frontiers)
      await putReadAllFrontiersIdb(workspaceId, resolved)
    }
  })

  applyCountersToCache(queryClient, workspaceId, mutators)
  publishReadAllFrontiersToCache(queryClient, workspaceId, resolved)
}
