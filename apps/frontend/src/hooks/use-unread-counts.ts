import { useCallback, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useWorkspaceService, useStreamService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { streamKeys } from "./use-streams"
import { useWorkspaceUnreadState } from "@/stores/workspace-store"
import { db } from "@/db"
import { applyStreamReadOrdinal, deriveActivityCounts } from "@/sync/unread-counters"
import { commitCounterMutation } from "@/sync/catch-up-batch"
import {
  applyReadStateSnapshotsIdb,
  mergeReadStateIntoBootstrapCache,
  publishReadAllFrontiersToCache,
  putReadAllFrontiersIdb,
  putReadStateIdb,
  putReadStateIdbIfUntouchedSince,
  readStateTouchedSince,
  resolveReadAllFrontiers,
  type ReadStateSnapshot,
  type ResolvedReadAllFrontier,
} from "@/sync/read-state"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "@/lib/sw-messages"
import type { WorkspaceBootstrap } from "@threa/types"

export type { ReadStateSnapshot }

const EMPTY_READ_SET: ReadonlySet<string> = new Set()

/** Drop one stream's entry from a sparse-overlay map, returning the same
 *  reference when there is nothing to remove. */
function withoutOverlay(
  map: Record<string, string[]> | undefined,
  streamId: string
): Record<string, string[]> | undefined {
  if (!map || !(streamId in map)) return map
  const next = { ...map }
  delete next[streamId]
  return next
}

/**
 * The counter patch a mark-as-read applies when the response carries no
 * ordinal (older backend): drop the stream's held activity rows on both paths,
 * and on a full read zero its message unread and overlay.
 */
function localCounterPatch(
  state: Pick<WorkspaceBootstrap, "unreadActivities" | "unreadCounts" | "readMessageIds">,
  streamId: string,
  partial: boolean | undefined
) {
  const rows = (state.unreadActivities ?? []).filter((a) => a.streamId !== streamId)
  return {
    unreadActivities: rows,
    ...deriveActivityCounts(rows),
    ...(partial
      ? {}
      : {
          unreadCounts: { ...state.unreadCounts, [streamId]: 0 },
          readMessageIds: withoutOverlay(state.readMessageIds, streamId),
        }),
  }
}

/**
 * The sparse read overlay for one stream as a referentially-stable set: the
 * message ids read individually above the stream's watermark
 * Reads IDB via `useLiveQuery`; the
 * returned set keeps its identity while the overlay's contents are unchanged, so
 * consumers can use it as a stable dependency.
 */
export function useReadMessageIds(workspaceId: string, streamId: string): ReadonlySet<string> {
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const ids = unreadState?.readMessageIds?.[streamId]
  // `useLiveQuery` structured-clones a fresh array on every IDB write, so key on
  // the overlay's CONTENT (not the array reference) to keep the returned set
  // referentially stable while the stream's overlay is unchanged.
  const key = ids && ids.length ? ids.join(" ") : ""
  const stable = useRef<{ key: string; set: ReadonlySet<string> }>({ key: "", set: EMPTY_READ_SET })
  if (stable.current.key !== key) {
    stable.current = { key, set: key === "" ? EMPTY_READ_SET : new Set(ids) }
  }
  return stable.current.set
}

/**
 * Optimistically apply sparse-read snapshots (from a conversation-surface read)
 * straight to IDB so the timeline overlay, board card, and badge update at once;
 * the authoritative `stream:read_messages` socket echo reconciles the query
 * cache. One apply path with the socket handler (`sync/read-state.ts`).
 * `startedAt` (the mutation's departure time) activates the per-stream
 * touched-at guard: legs touched after the request departed (its own echo, or
 * a later action) skip this stale response entirely.
 */
export function applyReadStateSnapshots(
  workspaceId: string,
  snapshots: ReadStateSnapshot[],
  startedAt?: number
): Promise<void> {
  return applyReadStateSnapshotsIdb(workspaceId, snapshots, startedAt)
}

export function useUnreadCounts(workspaceId: string) {
  const queryClient = useQueryClient()
  const streamService = useStreamService()
  const workspaceService = useWorkspaceService()

  // Read from IDB via useLiveQuery — reactive and offline-capable.
  // Use refs so callback identity stays stable; the sidebar memos that
  // depend on these callbacks won't recompute on every IDB write.
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const unreadCounts = unreadState?.unreadCounts ?? {}
  const unreadCountsRef = useRef(unreadCounts)
  unreadCountsRef.current = unreadCounts

  const getUnreadCount = useCallback((streamId: string): number => unreadCountsRef.current[streamId] ?? 0, [])

  const getTotalUnreadCount = useCallback(
    (): number => Object.values(unreadCountsRef.current).reduce((sum, count) => sum + count, 0),
    []
  )

  const markAsReadMutation = useMutation({
    mutationFn: async ({ streamId, lastEventId }: { streamId: string; lastEventId: string; partial?: boolean }) => {
      const startedAt = Date.now()
      const response = await streamService.markAsRead(workspaceId, streamId, lastEventId)
      return { ...response, startedAt }
    },
    onSuccess: async (
      { membership, readState, lastReadOrdinal, readMessageIds, startedAt },
      { streamId, lastEventId, partial }
    ) => {
      // A null readState is the server saying the read was a no-op — the event
      // id resolved to nothing, so nothing was written and nothing local may
      // move. Absent (older backend) keeps the legacy local-resolution path.
      if (readState === null) return
      // Ordering guard (touched-at): a read-state write that landed after this
      // mutation departed — the request's own socket echo, or a later action
      // (an explicit unread this stale read must not erase) — owns the stream.
      // The server's socket log is canonical; success is a no-op.
      if (await readStateTouchedSince(workspaceId, streamId, startedAt)) return
      const current = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
      const hadActivity = (current?.activityCounts[streamId] ?? 0) > 0
      // Null membership = a successful activity-only read by a viewer with
      // access but no membership row (INV-62: non-member thread leg, public
      // channel never joined). The activity clear below still applies; the
      // membership-shaped writes skip — spreading null would synthesize a junk
      // membership row in IDB.
      const hasMembership = membership !== null

      // The response's post-write ordinal IS the authoritative remainder, so it
      // reconciles the counters on BOTH paths through the same pure apply the
      // `stream:read` echo uses (INV-35) — the partial path no longer waits for
      // the echo to resolve the badge, and the full path lands on the same
      // zero. Without an ordinal (older backend) the legacy optimistic patch
      // stands: activity drop on both paths, message unread on the full path
      // only, since a partial read leaves unread below the pointer and the
      // ordinal read position MAX-merges — forcing "read = latest" there would
      // be sticky.
      const reconcileFromOrdinal = typeof lastReadOrdinal === "number"
      if (reconcileFromOrdinal) {
        commitCounterMutation(queryClient, workspaceId, (state) =>
          applyStreamReadOrdinal(state, streamId, lastReadOrdinal, readMessageIds ?? undefined)
        )
      }
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return {
          ...old,
          ...(reconcileFromOrdinal ? {} : localCounterPatch(old, streamId, partial)),
          // Membership is participation only — merge the fresh row (no watermark).
          streamMemberships: hasMembership
            ? old.streamMemberships.map((existingMembership) =>
                existingMembership.streamId === streamId ? { ...existingMembership, ...membership } : existingMembership
              )
            : old.streamMemberships,
        }
      })

      // Read frontier (sole source): the optimistic advance must move it for
      // EVERY viewer with access — member or not — or the divider stalls until
      // the socket echo. The response's `readState` is the server's post-write
      // truth, so it is used verbatim when present. Without it (older backend)
      // the id has no sequence, so resolve the read event's real one from the
      // cache — an id advanced without its sequence reads as "never read"
      // downstream. Resolution happens before the transaction below so the
      // transaction stays as narrow as it was.
      // An unconfirmed row is cached under its client id with a Date.now()-scale
      // placeholder sequence (`nextOptimisticSequence`), so it resolves here even
      // though the server has no such event — it no-ops the read and emits no
      // echo. Writing that placeholder would pin the frontier above every real
      // sequence for the session: no divider, no open-at-marker, and no recovery,
      // since every later echo and bootstrap merge is monotonic. Treat it as
      // unresolvable, like an id with no row at all. Reachable whenever the
      // viewer's own send is the bottom row when auto-read fires.
      const cached = readState ? undefined : await db.events.get(lastEventId)
      const readEvent = cached && (cached._status === "pending" || cached._status === "failed") ? undefined : cached
      if (!readState && !readEvent) {
        console.warn("Read frontier not advanced — read pointer has no confirmed event", { streamId, lastEventId })
      }
      // Monotonic, like the server: `ReadStateRepository.advance` rejects a
      // stale-device advance and returns the higher stored frontier, so a
      // "Mark as read up to here" on a row BELOW the watermark must not drag the
      // local frontier backward — that would resurface an already-read run as
      // unread until the echo lands. A sanctioned downward move is markUnread's
      // `stream:read_set`, not this path.
      const storedSequence = (await db.streamReadState.get(`${workspaceId}:${streamId}`))?.lastReadSequence
      const advanceSequence = readState ? readState.lastReadSequence : (readEvent?.sequence ?? null)
      const movesBackward =
        advanceSequence != null && storedSequence != null && BigInt(advanceSequence) < BigInt(storedSequence)
      const frontier = movesBackward
        ? null
        : readState ||
          (readEvent
            ? {
                lastReadEventId: lastEventId,
                lastReadSequence: readEvent.sequence,
                lastReadAt: new Date().toISOString(),
              }
            : null)
      // Re-check before the cache writes, not just before the IDB write below:
      // the two resolution reads above are await points the old synchronous path
      // did not have, so an echo landing in that window would otherwise leave the
      // query cache holding a lower frontier than IDB.
      if (frontier && !(await readStateTouchedSince(workspaceId, streamId, startedAt))) {
        mergeReadStateIntoBootstrapCache(queryClient, workspaceId, streamId, frontier)
        queryClient.setQueryData(
          streamKeys.bootstrap(workspaceId, streamId),
          (old: import("@threa/types").StreamBootstrap | undefined) => {
            if (!old) return old
            return { ...old, readState: frontier }
          }
        )
      }

      // Counters, membership participation, and the standalone frontier row
      // land in one transaction — the frontier row is the unread divider's
      // sole source (no stream/membership watermark mirrors remain).
      await db.transaction("rw", [db.unreadState, db.streamMemberships, db.streamReadState], async () => {
        // INV-20 re-check: a touch landing between the guard above and this
        // transaction still wins over the stale response.
        if (await readStateTouchedSince(workspaceId, streamId, startedAt)) return
        const now = Date.now()
        // `commitCounterMutation` owns the counter row when the response
        // reconciled it (it persists and stamps `counterTouchedAt` itself);
        // writing a snapshot read here would race it back.
        const state = reconcileFromOrdinal ? undefined : await db.unreadState.get(workspaceId)
        if (state) {
          await db.unreadState.put({
            ...state,
            ...localCounterPatch(state, streamId, partial),
            // Touch stamp: an in-flight bootstrap's per-stream merge must not
            // resurrect the pre-read snapshot (mergeBootstrapUnreadFields).
            counterTouchedAt: { ...state.counterTouchedAt, [streamId]: now },
            _cachedAt: now,
          })
        }

        const membershipId = `${workspaceId}:${streamId}`
        if (hasMembership) {
          const existingMembership = await db.streamMemberships.get(membershipId)
          if (existingMembership) {
            await db.streamMemberships.put({
              ...existingMembership,
              ...membership,
              id: membershipId,
              workspaceId,
              _cachedAt: now,
            })
          } else {
            await db.streamMemberships.put({
              ...membership,
              id: membershipId,
              workspaceId,
              _cachedAt: now,
            })
          }
        }

        // The frontier row moves for members and non-members alike.
        if (frontier) {
          await putReadStateIdb(workspaceId, streamId, frontier, now)
        }
      })

      if (hadActivity) {
        queryClient.invalidateQueries({ queryKey: ["activity", workspaceId] })
      }
    },
  })

  const markUnreadMutation = useMutation({
    mutationFn: async ({ streamId, messageId }: { streamId: string; messageId: string }) => {
      const startedAt = Date.now()
      const result = await streamService.markUnread(workspaceId, streamId, messageId)
      return { ...result, startedAt }
    },
    onSuccess: async ({ readState, startedAt }, { streamId }) => {
      if (!readState || !(await putReadStateIdbIfUntouchedSince(workspaceId, streamId, readState, startedAt))) return
      mergeReadStateIntoBootstrapCache(queryClient, workspaceId, streamId, readState)
      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        return { ...old, readState }
      })
    },
  })

  const markAllAsReadMutation = useMutation({
    mutationFn: async () => {
      const startedAt = Date.now()
      const { updatedStreamIds, frontiers } = await workspaceService.markAllAsRead(workspaceId)
      return { updatedStreamIds, frontiers, startedAt }
    },
    onSuccess: async ({ updatedStreamIds, frontiers, startedAt }) => {
      // Ordering guard (touched-at), per stream: a read-state write that landed
      // after this request departed — its own stream:read_all socket echo, or a
      // LATER action (an explicit unread this stale mark-all must not erase) —
      // owns that stream. Skip every response effect there: counter zeroing,
      // overlay clear, held-activity clear, frontier advance, cache
      // publication. Untouched streams from the same response still apply in
      // the same atomic transaction. Operation order (touched-at) decides — no
      // max-merge over a later explicit unread.
      const touched = new Set<string>()
      for (const streamId of updatedStreamIds) {
        if (await readStateTouchedSince(workspaceId, streamId, startedAt)) touched.add(streamId)
      }
      const effectiveStreamIds = updatedStreamIds.filter((streamId) => !touched.has(streamId))

      // Counter/overlay/activity publication precedes the IDB transaction, so a
      // persistence failure still leaves the initiating device's cache cleared.
      // Touched streams keep their later state: counters stay raised, held
      // activity rows survive — the stale response must not erase them.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const newUnread = { ...old.unreadCounts }
        const newReadMessageIds = { ...old.readMessageIds }
        for (const streamId of effectiveStreamIds) {
          newUnread[streamId] = 0
          delete newReadMessageIds[streamId]
        }
        const rows = (old.unreadActivities ?? []).filter((a) => a.streamId !== null && touched.has(a.streamId))
        return {
          ...old,
          unreadCounts: newUnread,
          readMessageIds: newReadMessageIds,
          unreadActivities: rows,
          ...deriveActivityCounts(rows),
        }
      })

      // Persistence: ONE transaction over every table this read-all touches —
      // the counter singleton (unread zeroing, overlay clearing, activity
      // clearing) plus `db.streamReadState` (the guard re-check reads it too) —
      // so a failure can never land the counter clear without the frontier rows
      // or vice versa. The response's canonical post-write frontiers resolve
      // INSIDE the transaction (max-merged over IDB + caches, touched streams
      // excluded so a later explicit unread is never max-merged away) so the
      // pick and the write see the same table state; a response from before the
      // field shipped omits `frontiers` — legacy counter behavior, frontier
      // rows untouched.
      const responseFrontiers = frontiers ?? []
      let resolved: ResolvedReadAllFrontier[] = []
      await db.transaction("rw", [db.unreadState, db.streamReadState], async () => {
        // INV-20 re-check: a touch landing between the guard above and this
        // transaction still wins over the stale response. The rw lock holds the
        // outcome stable for the rest of the transaction.
        const txTouched = new Set<string>()
        for (const streamId of updatedStreamIds) {
          if (await readStateTouchedSince(workspaceId, streamId, startedAt)) txTouched.add(streamId)
        }
        const state = await db.unreadState.get(workspaceId)
        if (state) {
          const now = Date.now()
          const newUnread = { ...state.unreadCounts }
          const newReadMessageIds = { ...state.readMessageIds }
          const counterTouchedAt = { ...state.counterTouchedAt }
          for (const streamId of updatedStreamIds) {
            if (txTouched.has(streamId)) continue
            newUnread[streamId] = 0
            delete newReadMessageIds[streamId]
            counterTouchedAt[streamId] = now
          }
          const rows = (state.unreadActivities ?? []).filter((a) => a.streamId !== null && txTouched.has(a.streamId))
          await db.unreadState.put({
            ...state,
            unreadCounts: newUnread,
            readMessageIds: newReadMessageIds,
            unreadActivities: rows,
            ...deriveActivityCounts(rows),
            counterTouchedAt,
            _cachedAt: now,
          })
        }
        if (responseFrontiers.length > 0) {
          const effectiveFrontiers = responseFrontiers.filter((snapshot) => !txTouched.has(snapshot.streamId))
          resolved = await resolveReadAllFrontiers(queryClient, workspaceId, effectiveFrontiers)
          await putReadAllFrontiersIdb(workspaceId, resolved)
        }
      })

      // Frontier publication only after persistence succeeded, so the divider
      // tracks immediately on the initiating device — never publishing a state
      // the IDB lacks.
      publishReadAllFrontiersToCache(queryClient, workspaceId, resolved)
    },
  })

  const markAsRead = useCallback(
    (streamId: string, lastEventId: string, opts?: { partial?: boolean }) => {
      // Never advance the read pointer to an optimistic event: its temp_ id has no
      // server stream_events row, so persisting it pins the watermark to sequence 0
      // and reports the whole stream — including the user's own messages — as
      // unread. The auto-read effect re-fires with the real id once the server echo
      // swaps it in.
      if (lastEventId.startsWith("temp_")) return Promise.resolve({ applied: false })
      const commit = markAsReadMutation.mutateAsync({ streamId, lastEventId, partial: opts?.partial })
      // Dismiss any push notification for this stream — advancing the read pointer
      // (auto-read, manual "Mark as read", or Escape) means the user is here, so
      // the banner is noise. Centralized on this single-stream read-advance funnel
      // so each of those paths clears locally, not just auto-read; mark-all-read
      // clears via its stream:read_all socket echo. Other devices dismiss via
      // their own socket echo when open, or the bootstrap sweep on next open
      // (lib/notification-sweep.ts) — never via push, which would burn quota.
      navigator.serviceWorker?.controller?.postMessage({ type: SW_MSG_CLEAR_NOTIFICATIONS, streamId })
      // `applied: false` = the server no-op'd (the event id resolved to nothing),
      // so the queue must not record the frontier as committed. An older backend
      // omits `readState`; that keeps today's meaning — a 200 is a commit.
      return commit.then((response) => ({ applied: response.readState !== null }))
    },
    [markAsReadMutation]
  )

  const markAllAsRead = useCallback(() => {
    markAllAsReadMutation.mutate()
  }, [markAllAsReadMutation])

  const markUnread = useCallback(
    async (streamId: string, messageId: string) => {
      const { readState } = await markUnreadMutation.mutateAsync({ streamId, messageId })
      const reconciled = await db.streamReadState.get(`${workspaceId}:${streamId}`)
      return reconciled ? reconciled.lastReadEventId : readState?.lastReadEventId
    },
    [markUnreadMutation, workspaceId]
  )

  return {
    unreadCounts,
    getUnreadCount,
    getTotalUnreadCount,
    markAsRead,
    markUnread,
    markAllAsRead,
    isMarkingAsRead: markAsReadMutation.isPending,
    isMarkingAllAsRead: markAllAsReadMutation.isPending,
  }
}
