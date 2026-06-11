import type { Querier } from "../../db"
import { sql } from "../../db"
import { Visibilities } from "@threa/types"
import { StreamRepository, type Stream } from "./repository"
import { StreamMemberRepository } from "./member-repository"

/**
 * Minimal structural shape this helper needs: the stream's id and a
 * (possibly null) `rootStreamId`. Generic so callers with subset types
 * (e.g. the sharing feature's `SharingStream`) can route through without
 * forcing a full `Stream` instantiation.
 */
export interface AccessResolvable {
  id: string
  rootStreamId: string | null
}

/**
 * Resolves the stream whose `visibility` and `stream_members` rows are
 * authoritative for access decisions. Top-level streams are their own
 * authoritative source; threads inherit from their root.
 *
 * Single source of truth for the "thread → root" access pattern. Every
 * helper that decides "can user X read stream Y?" or "is this stream
 * effectively private?" routes through here, so subtle drifts (stale
 * thread visibility, sparse thread member sets) can't reintroduce holes.
 *
 * Falls back to the input stream when the root row is missing — the
 * FK-less schema (INV-1) means a dangling `root_stream_id` is possible
 * and we shouldn't crash on it. Generic in `T extends AccessResolvable`
 * so the callback returns the same shape it was given (a thread → its
 * root will lose row-level extras the caller wasn't tracking, which is
 * fine — only id/visibility/membership matter for access).
 */
export async function resolveEffectiveAccessStream<T extends AccessResolvable>(
  db: Querier,
  stream: T
): Promise<T | Stream> {
  if (!stream.rootStreamId) return stream
  const root = await StreamRepository.findById(db, stream.rootStreamId)
  return root ?? stream
}

/**
 * Canonical "does this user have access to this stream?" check.
 *
 * Returns the stream when access is granted; `null` otherwise. Handles all
 * three cases callers usually get wrong when they reach for
 * `StreamMemberRepository.isMember` directly:
 *
 * 1. **Workspace boundary** — a stream belonging to another workspace is
 *    treated as inaccessible (INV-8), even when the caller's userId
 *    happens to be a member elsewhere.
 * 2. **Public channels** — public channels grant read access to every
 *    workspace member without requiring a `stream_members` row, so
 *    membership-only checks would falsely deny access.
 * 3. **Threads** — threads inherit access from their root stream's
 *    membership/visibility; checking membership on the thread itself is
 *    nearly always wrong.
 *
 * Use this from any feature that needs to gate on stream access. Inlining
 * `StreamMemberRepository.isMember` plus visibility logic is a recurring
 * footgun (membership ≠ access) — route everything through here so the
 * three cases above stay consistent (INV-62).
 *
 * Takes a `Querier` so it composes with existing transactions (`withClient`
 * / `withTransaction` blocks) without acquiring an extra connection. The
 * `StreamService.checkAccess` wrapper is a thin `withClient(...)` around
 * this for callers that don't have a Querier in scope.
 */
export async function checkStreamAccess(
  db: Querier,
  streamId: string,
  workspaceId: string,
  userId: string
): Promise<Stream | null> {
  const stream = await StreamRepository.findById(db, streamId)
  if (!stream || stream.workspaceId !== workspaceId) return null

  const effective = await resolveEffectiveAccessStream(db, stream)
  // A thread whose root is missing collapses back to the thread itself —
  // not accessible without the root present. Compare ids rather than
  // object identity so this stays correct if the resolver ever returns a
  // copy on the dangling-root fallback.
  if (stream.rootStreamId && effective.id !== stream.rootStreamId) return null

  if (effective.visibility !== Visibilities.PUBLIC) {
    const isMember = await StreamMemberRepository.isMember(db, effective.id, userId)
    if (!isMember) return null
  }
  return stream
}

/**
 * Batched equivalent of {@link checkStreamAccess}. Given a candidate set
 * of stream ids in a workspace, returns the subset the viewer can read.
 *
 * Encodes the same three rules as `checkStreamAccess` /
 * {@link resolveEffectiveAccessStream} in one SQL round-trip so
 * cross-cutting features (pointer hydration, search, activity feeds) can
 * filter many stream ids at once without an N+1. Keep the predicate in
 * sync with the per-id helpers — when the rule for thread → root
 * resolution changes, both code paths update together.
 *
 * Empty input → empty Set; missing/cross-workspace ids are silently dropped
 * exactly like the per-id helper returning `null`.
 */
export async function listAccessibleStreamIds(
  db: Querier,
  workspaceId: string,
  userId: string,
  candidateStreamIds: readonly string[]
): Promise<Set<string>> {
  if (candidateStreamIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(sql`
    SELECT s.id
    FROM streams s
    LEFT JOIN streams root ON root.id = s.root_stream_id
    WHERE s.workspace_id = ${workspaceId}
      AND s.id = ANY(${candidateStreamIds as string[]})
      AND (
        (s.root_stream_id IS NULL AND (
          s.visibility = ${Visibilities.PUBLIC}
          OR EXISTS (
            SELECT 1 FROM stream_members
            WHERE stream_id = s.id AND member_id = ${userId}
          )
        ))
        OR
        (s.root_stream_id IS NOT NULL AND root.id IS NOT NULL AND (
          root.visibility = ${Visibilities.PUBLIC}
          OR EXISTS (
            SELECT 1 FROM stream_members
            WHERE stream_id = s.root_stream_id AND member_id = ${userId}
          )
        ))
      )
  `)
  return new Set(result.rows.map((r) => r.id))
}
