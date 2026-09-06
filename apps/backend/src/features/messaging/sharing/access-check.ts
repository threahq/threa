import type { Querier } from "../../../db"
import { Visibilities, type Visibility } from "@threahq/types"

/**
 * Minimal structural shape needed to answer the source-visibility check.
 * Defined here so the sharing sub-feature does not import from the streams
 * feature — satisfies INV-52 and breaks the barrel cycle that arises
 * because streams/handlers.ts imports hydration helpers from the messaging
 * barrel. Ancestry, member-counting, and read-access live in the DB and are
 * answered by the injected callbacks, not by walking or querying app-side
 * (INV-5).
 *
 * `rootStreamId` is exposed so the privacy boundary can resolve a thread
 * source through to its root: thread access lives entirely on the root's
 * `stream_members` rows (creator + parent author are added to the thread
 * for notification scoping but otherwise membership doesn't gate read
 * access — `checkStreamAccess` reads root-only). The thread row's stored
 * `visibility` is set at create time and never re-synced when the root's
 * visibility changes, so the boundary check would silently miss
 * private-source shares from threads of channels that were privatized
 * after the thread was created. Resolving to the root closes that hole
 * and also fixes the over-count (countExposedMembers against a sparsely-
 * populated thread vs. the actual root member set).
 */
export interface SharingStream {
  id: string
  workspaceId: string
  visibility: Visibility
  rootStreamId: string | null
}

export type FindStreamForSharing = (db: Querier, id: string) => Promise<SharingStream | null>

/**
 * Resolves the stream whose visibility + member set are authoritative for
 * access decisions on the given source. Top-level streams are their own
 * authoritative source; threads route through to the root.
 *
 * Injected so this sub-feature stays free of a direct streams-feature
 * import (INV-52) and so the resolution lives in one place — currently
 * `streams/access.ts`'s `resolveEffectiveAccessStream`. If/when the
 * thread→root rule changes (e.g. nested threads, role-based shadowing),
 * the canonical helper updates and every call site picks it up.
 */
export type ResolveEffectiveStream = (db: Querier, source: SharingStream) => Promise<SharingStream>

/**
 * Returns true when `ancestorCandidateId` is `streamId` itself or appears
 * anywhere on its parent chain. Implemented in the streams repository as a
 * single recursive CTE; injected here as a callback so the sharing sub-feature
 * stays free of a direct `StreamRepository` import (INV-52).
 */
export type IsAncestorStream = (db: Querier, ancestorCandidateId: string, streamId: string) => Promise<boolean>

/**
 * Counts members of `targetStreamId` who are NOT already members of
 * `sourceStreamId` — the number of users who would gain implicit read via
 * the share. Implemented in the stream-member repository; injected here so
 * access-check never issues its own SQL (INV-5) and stays cycle-free with
 * the streams feature (INV-52).
 */
export type CountExposedMembers = (db: Querier, targetStreamId: string, sourceStreamId: string) => Promise<number>

/**
 * Returns true when `userId` has read access to `streamId` in `workspaceId`
 * (direct or inherited via root stream, or the stream is public). Injected
 * so the sharing service can gate shares on the sharer's read access without
 * importing the streams feature directly (INV-52).
 */
export type CanReadStream = (db: Querier, workspaceId: string, streamId: string, userId: string) => Promise<boolean>

export interface PrivacyBoundaryResult {
  /** True when target members exist who cannot already see the source stream. */
  triggered: boolean
  /** Count of target members who would gain implicit read via the share. */
  exposedUserCount: number
}

/**
 * Checks whether sharing from `sourceStreamId` into `targetStreamId` would
 * expose the source to target members who don't already have access. The
 * warning triggers only when the effective source is private AND at least
 * one target member isn't in the effective-source's stream_members set.
 *
 * For thread sources, "effective source" is the root: thread access is
 * gated by the root's membership and visibility, and the thread row's
 * stored visibility goes stale when the root's flips. Counting exposure
 * against thread members would also wildly over-warn — threads only
 * carry creator + parent-author rows by default.
 *
 * Share-to-parent short-circuits: if `targetStreamId` is an ancestor of
 * `sourceStreamId`, the parent audience already contains the thread's
 * audience by construction, so nothing new is revealed.
 */
export async function crossesPrivacyBoundary(
  db: Querier,
  findStream: FindStreamForSharing,
  resolveEffective: ResolveEffectiveStream,
  isAncestor: IsAncestorStream,
  countExposedMembers: CountExposedMembers,
  sourceStreamId: string,
  targetStreamId: string
): Promise<PrivacyBoundaryResult> {
  if (sourceStreamId === targetStreamId) {
    return { triggered: false, exposedUserCount: 0 }
  }

  if (await isAncestor(db, targetStreamId, sourceStreamId)) {
    return { triggered: false, exposedUserCount: 0 }
  }

  const source = await findStream(db, sourceStreamId)
  if (!source) return { triggered: false, exposedUserCount: 0 }

  const effectiveSource = await resolveEffective(db, source)
  if (effectiveSource.visibility !== Visibilities.PRIVATE) {
    return { triggered: false, exposedUserCount: 0 }
  }

  const exposedUserCount = await countExposedMembers(db, targetStreamId, effectiveSource.id)
  return { triggered: exposedUserCount > 0, exposedUserCount }
}
