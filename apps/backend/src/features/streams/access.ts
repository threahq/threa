import type { QueryConfig } from "pg"
import type { Querier } from "../../db"
import { sql, composeSql } from "../../db"
import { Visibilities } from "@threahq/types"
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

export interface EffectiveAccessStreamFact<T extends AccessResolvable> {
  target: T
  root: Stream
}

export async function resolveEffectiveAccessStreams<T extends AccessResolvable & { workspaceId: string }>(
  db: Querier,
  workspaceId: string,
  streams: readonly T[]
): Promise<EffectiveAccessStreamFact<T>[]> {
  if (streams.length === 0) return []
  const rootIds = [...new Set(streams.map((stream) => stream.rootStreamId ?? stream.id))]
  const roots = await StreamRepository.findByIdsInWorkspace(db, workspaceId, rootIds)
  const rootsById = new Map(roots.map((root) => [root.id, root]))

  return streams.flatMap((target) => {
    if (target.workspaceId !== workspaceId) return []
    const root = rootsById.get(target.rootStreamId ?? target.id)
    return root ? [{ target, root }] : []
  })
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
 * The canonical "is this *already-resolved effective root* readable by the
 * user?" leaf: public visibility OR a `stream_members` row on the root. This is
 * the single rule that both the per-id predicate ({@link streamAccessPredicateSql})
 * and the workspace catch-up CTE (`features/sync/repository.ts`) reduce a
 * stream's effective root down to — extracted so the public-without-membership
 * branch cannot live in one and be silently dropped from the other (catch-up
 * replicating the thread→root leg while omitting the public-root leg is the
 * drift this guards against). The caller resolves the effective root
 * (top-level stream → itself, thread → its root) and passes its alias; this
 * fragment only decides readability of that resolved root.
 *
 * `rootAlias` is injected raw (squid `raw`) because it is a SQL alias reference,
 * not a value — it MUST be a trusted constant supplied by call-site code (e.g.
 * `"eff_root"`), NEVER derived from user input. Built with squid `sql` so it
 * carries `$1..$k` placeholders that {@link composeSql} renumbers when splicing
 * it into a larger query.
 */
export function rootReadableConditionSql(userId: string, rootAlias: string): QueryConfig {
  return sql`(
    ${sql.raw(rootAlias)}.visibility = ${Visibilities.PUBLIC}
    OR EXISTS (
      SELECT 1 FROM stream_members
      WHERE stream_id = ${sql.raw(rootAlias)}.id AND member_id = ${userId}
    )
  )`
}

/**
 * Canonical SQL predicate for the "thread → root" stream-access rule
 * (INV-62), as a reusable `EXISTS` fragment correlated to a stream-id
 * column. This is the single source of truth for the *set-based* form of
 * the same three rules `checkStreamAccess` enforces per-id (workspace
 * boundary, public root grants read without a `stream_members` row, threads
 * inherit from their root). The effective root is resolved with
 * `COALESCE(root_stream_id, id)` (a top-level stream is its own root, a thread
 * defers to its root; a thread whose root row is missing finds no join and is
 * denied), then {@link rootReadableConditionSql} decides readability — the same
 * leaf the catch-up CTE applies, so the two cannot drift.
 *
 * The returned `QueryConfig` is spliced into a larger query via
 * {@link composeSql} (squid's own `sql` tag cannot nest fragments — it would
 * parametrize the whole object). Any row source can gate on stream access by
 * dropping this into its WHERE:
 *
 * ```ts
 * composeSql`... WHERE ${streamAccessPredicateSql(ws, user, "a.stream_id")}`
 * ```
 *
 * `streamIdColumn` is injected raw (squid `raw`) because it is a SQL column
 * reference, not a value — so it MUST be a trusted constant column ref
 * supplied by call-site code (e.g. `"a.stream_id"`, `"s.id"`), NEVER derived
 * from user input. The fragment is fully self-contained: it re-checks the
 * workspace boundary inside the EXISTS, so it is correct even when the outer
 * query does not otherwise constrain the stream's workspace.
 */
export function streamAccessPredicateSql(workspaceId: string, userId: string, streamIdColumn: string): QueryConfig {
  return composeSql`EXISTS (
    SELECT 1
    FROM streams eff_s
    JOIN streams eff_root ON eff_root.id = COALESCE(eff_s.root_stream_id, eff_s.id)
    WHERE ${sql`eff_s.id = ${sql.raw(streamIdColumn)}`}
      AND eff_s.workspace_id = ${workspaceId}
      AND ${rootReadableConditionSql(userId, "eff_root")}
  )`
}

/**
 * Room-uniform readability: the subset of candidate stream ids in the
 * workspace that are readable by the room as a whole — the room stream
 * itself, plus candidates whose effective root (thread → root via
 * `COALESCE(root_stream_id, id)`) is public. No viewer and no
 * `stream_members` leg: per-user membership grants are meaningless for a
 * payload delivered to everyone in the room.
 *
 * Empty input → empty Set; missing/cross-workspace ids are silently dropped.
 */
export async function listRoomReadableStreamIds(
  db: Querier,
  workspaceId: string,
  roomStreamId: string,
  candidateStreamIds: readonly string[]
): Promise<Set<string>> {
  if (candidateStreamIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(sql`
    SELECT s.id
    FROM streams s
    JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id)
    WHERE s.workspace_id = ${workspaceId}
      AND s.id = ANY(${candidateStreamIds as string[]})
      AND (s.id = ${roomStreamId} OR root.visibility = ${Visibilities.PUBLIC})
  `)
  return new Set(result.rows.map((r) => r.id))
}

/**
 * Batched equivalent of {@link checkStreamAccess}. Given a candidate set
 * of stream ids in a workspace, returns the subset the viewer can read.
 *
 * Routes through {@link streamAccessPredicateSql} so the thread → root
 * access rule has exactly one definition shared with the cross-cutting
 * features (search, attachments) that filter many stream ids at once
 * without an N+1.
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
  const result = await db.query<{ id: string }>(composeSql`
    SELECT s.id
    FROM streams s
    WHERE s.workspace_id = ${workspaceId}
      AND s.id = ANY(${candidateStreamIds as string[]})
      AND ${streamAccessPredicateSql(workspaceId, userId, "s.id")}
  `)
  return new Set(result.rows.map((r) => r.id))
}
