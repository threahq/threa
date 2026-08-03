import { useStreamFromStore } from "@/stores/stream-store"

export interface EffectiveArchivedInput {
  /** The anchor stream row (its own `archivedAt` seals the surface directly). */
  stream: { archivedAt?: string | null } | null | undefined
  /** The root to inherit from (INV-62), or null when the anchor IS the root. */
  rootStreamId: string | null | undefined
  /**
   * A root row the caller already resolved (`null` = resolved as absent). When
   * omitted the hook resolves it itself from the stream store; callers holding
   * a warm-cached row pass it so the first render doesn't report the root
   * absent and flash the cold-load verdict.
   */
  rootStream?: { archivedAt?: string | null } | null
  /**
   * Cold-load verdict for the root, used only when the root row is absent from
   * the local stream cache: the per-stream bootstrap's `rootArchivedAt` for the
   * timeline, the board post's `rootArchived` for the conversation surfaces.
   */
  fallbackRootArchived: string | boolean | null | undefined
}

export interface EffectiveArchived {
  /** The anchor stream itself is archived. */
  ownArchived: boolean
  /** The root this surface inherits from is archived. */
  rootArchived: boolean
  isArchived: boolean
}

/**
 * Effective archived state for a stream-anchored surface. A thread (or a
 * conversation anchored in one) inherits its lifecycle from its root (INV-62):
 * archiving marks only the root row, so the anchor's own `archivedAt` can't
 * tell the client it is sealed. The root's state comes from two sources,
 * chosen by whether the root is resident in the local stream cache:
 *
 *   - root in `db.streams` → use its `archivedAt`. This is live:
 *     `stream:archived`/`stream:unarchived` are routed to the thread's room
 *     too, so the row updates and this value re-renders without a refresh.
 *     Covers live archive/unarchive and rapid toggling.
 *   - root absent → the cold-load deep-link case (a thread whose root the local
 *     cache hasn't got — an already-archived root reached by deep link has no
 *     row to read). Fall back to the caller's cold-load verdict.
 *
 * The same applies when the ANCHOR row itself is absent: the caller derives
 * `rootStreamId` from that row, so an absent anchor leaves the chain
 * unresolvable — the fallback is a verdict about the effective root and still
 * applies.
 *
 * The two absences ("root active" vs "root unknown") must NOT be merged — that
 * collapses them and lets a stale fallback win after unarchive, which was the
 * flicker/rapid-toggle bug.
 */
export function useEffectiveArchived({
  stream,
  rootStreamId,
  rootStream,
  fallbackRootArchived,
}: EffectiveArchivedInput): EffectiveArchived {
  const selfResolvedRoot = useStreamFromStore(rootStream === undefined ? (rootStreamId ?? undefined) : undefined)
  const rootRow = rootStream === undefined ? selfResolvedRoot : rootStream
  const fallbackArchived = fallbackRootArchived != null && fallbackRootArchived !== false
  let rootArchived = false
  if (rootStreamId) {
    rootArchived = rootRow ? rootRow.archivedAt != null : fallbackArchived
  } else if (!stream) {
    rootArchived = fallbackArchived
  }
  const ownArchived = stream?.archivedAt != null
  return { ownArchived, rootArchived, isArchived: ownArchived || rootArchived }
}
