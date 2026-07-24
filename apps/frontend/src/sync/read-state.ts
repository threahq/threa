import type { QueryClient } from "@tanstack/react-query"
import type { StreamBootstrap, StreamReadFrontier, WorkspaceBootstrap } from "@threa/types"
import { db, type CachedStreamReadState } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import { applyStreamReadMessages, dropMessageActivities } from "./unread-counters"
import { putCountersIdb, type CounterMutator } from "./catch-up-batch"

/**
 * Upsert the standalone read-frontier row in IDB (read cutover dual-write).
 * Runs inside the caller's `rw` transaction alongside the legacy mirror
 * writes. Row presence is authoritative for frontier readers, so every read
 * applier that moves a legacy mirror also writes this row.
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
  return row !== undefined && row._cachedAt >= since
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

/** Mirror a snapshot's watermark fields into the query cache (workspace +
 *  stream bootstrap membership rows AND the standalone frontier map) so the
 *  unread divider tracks immediately. */
function mirrorSnapshotToCache(queryClient: QueryClient, workspaceId: string, snapshot: ReadStateSnapshot): void {
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    return {
      ...old,
      streamMemberships: old.streamMemberships.map((membership) =>
        membership.streamId === snapshot.streamId
          ? { ...membership, lastReadEventId: snapshot.lastReadEventId, lastReadSequence: snapshot.lastReadSequence }
          : membership
      ),
      streamReadState: {
        ...(old.streamReadState ?? {}),
        [snapshot.streamId]: {
          lastReadEventId: snapshot.lastReadEventId,
          lastReadSequence: snapshot.lastReadSequence,
          lastReadAt: new Date().toISOString(),
        },
      },
    }
  })

  queryClient.setQueryData<StreamBootstrap | undefined>(streamKeys.bootstrap(workspaceId, snapshot.streamId), (old) => {
    if (!old?.membership) return old
    return {
      ...old,
      membership: {
        ...old.membership,
        lastReadEventId: snapshot.lastReadEventId,
        lastReadSequence: snapshot.lastReadSequence,
      },
    }
  })
}

/** Write a snapshot's watermark mirrors to IDB. Must run inside an open `rw`
 *  transaction that includes `db.streams`, `db.streamMemberships`, and
 *  `db.streamReadState`. */
async function writeSnapshotWatermarkIdb(workspaceId: string, snapshot: ReadStateSnapshot): Promise<void> {
  const now = Date.now()
  await db.streams.update(snapshot.streamId, { lastReadEventId: snapshot.lastReadEventId, _cachedAt: now })

  const membershipId = `${workspaceId}:${snapshot.streamId}`
  const membership = await db.streamMemberships.get(membershipId)
  if (membership) {
    await db.streamMemberships.put({
      ...membership,
      lastReadEventId: snapshot.lastReadEventId,
      lastReadSequence: snapshot.lastReadSequence,
      id: membershipId,
      workspaceId,
      _cachedAt: now,
    })
  }

  await putReadStateIdb(
    workspaceId,
    snapshot.streamId,
    {
      lastReadEventId: snapshot.lastReadEventId,
      lastReadSequence: snapshot.lastReadSequence,
      lastReadAt: new Date().toISOString(),
    },
    now
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
  void db.transaction("rw", [db.streams, db.streamMemberships, db.streamReadState], () =>
    writeSnapshotWatermarkIdb(workspaceId, snapshot)
  )
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
  await db.transaction("rw", [db.unreadState, db.streams, db.streamMemberships, db.streamReadState], async () => {
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
