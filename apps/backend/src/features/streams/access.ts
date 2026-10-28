import type { QueryConfig } from "pg"
import type { Querier } from "../../db"
import { sql, composeSql } from "../../db"
import { StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import {
  PeoplePurposes,
  anyUserLacksBrowseSql,
  findUserIdsWithoutBrowse,
  peopleScopeSql,
  viewerLacksBrowseSql,
} from "../workspaces"
import { StreamRepository, type Stream } from "./repository"

/**
 * Minimal structural shape this helper needs: the stream's id and a
 * (possibly null) `rootStreamId`. Generic so callers with subset types
 * can route through without forcing a full `Stream` instantiation.
 */
export interface AccessResolvable {
  id: string
  workspaceId: string
  rootStreamId: string | null
}

/**
 * Resolves the stream whose `visibility` and `stream_members` rows are
 * authoritative for access decisions. Top-level streams are their own
 * authoritative source; threads inherit from their root.
 *
 * Callers that need the effective root row in memory (write authority,
 * effective privacy) route through here. Read access is decided in SQL by
 * {@link streamAccessPredicateSql}, which resolves the same root.
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
  const root = await StreamRepository.findById(db, stream.workspaceId, stream.rootStreamId)
  return root ?? stream
}

export interface EffectiveAccessStreamFact<T extends AccessResolvable> {
  target: T
  root: Stream
}

export async function resolveEffectiveAccessStreams<T extends AccessResolvable>(
  db: Querier,
  workspaceId: string,
  streams: readonly T[]
): Promise<EffectiveAccessStreamFact<T>[]> {
  if (streams.length === 0) return []
  const rootIds = [...new Set(streams.map((stream) => stream.rootStreamId ?? stream.id))]
  const roots = await StreamRepository.findByIds(db, workspaceId, rootIds)
  const rootsById = new Map(roots.map((root) => [root.id, root]))

  return streams.flatMap((target) => {
    if (target.workspaceId !== workspaceId) return []
    const root = rootsById.get(target.rootStreamId ?? target.id)
    return root ? [{ target, root }] : []
  })
}

/**
 * `docGrants: false` decides access without the `shared_docs` leg: what a reader reaches through
 * membership and visibility alone. Defaults to true.
 */
export interface StreamAccessOptions {
  docGrants?: boolean
}

/**
 * Whether an access scope (an agent's `accessibleStreamIds`) reads a doc without a share grant: the scope
 * already holds grant-reached docs, and only the doc's root says the scope reads it on its own.
 */
export function scopeReadsDocWithoutGrant(
  scope: ReadonlySet<string>,
  doc: Pick<Stream, "id" | "rootStreamId">
): boolean {
  return scope.has(doc.id) && scope.has(doc.rootStreamId ?? doc.id)
}

/**
 * Canonical "does this user have access to this stream?" check.
 *
 * Returns the stream when access is granted; `null` otherwise. Handles all
 * four cases a direct `StreamMemberRepository.isMember` check misses:
 *
 * 1. **Workspace boundary** — a stream belonging to another workspace is
 *    treated as inaccessible (INV-8), even when the caller's userId
 *    happens to be a member elsewhere.
 * 2. **Open channels** — `guest_public` channels grant read access to every
 *    workspace user and `public` channels to every user with browse, neither
 *    requiring a `stream_members` row, so membership-only checks would
 *    falsely deny access.
 * 3. **Threads** — threads inherit access from their root stream's
 *    membership/visibility; checking membership on the thread itself is
 *    nearly always wrong.
 * 4. **Doc grants** — a doc is also readable by readers of a stream holding
 *    an undeleted message that carries its chip.
 *
 * Use this from any feature that needs to gate on stream access. Inlining
 * `StreamMemberRepository.isMember` plus visibility logic is a recurring
 * footgun (membership ≠ access) — route everything through here so the
 * four cases above stay consistent (INV-62).
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
  userId: string,
  options?: StreamAccessOptions
): Promise<Stream | null> {
  const stream = await StreamRepository.findById(db, workspaceId, streamId)
  if (!stream) return null
  const accessible = await listAccessibleStreamIds(db, workspaceId, userId, [stream.id], options)
  return accessible.has(stream.id) ? stream : null
}

/**
 * The legs of root readability that need no `stream_members` row: `guest_public` is open to every
 * workspace user, `public` to users with browse. Exported on its own because the catch-up history
 * bound asks the same question. `rootAlias` is a trusted SQL alias, never user input. A `QueryConfig`
 * `userId` correlates to an outer row's user and must not name `u` or `wup`, which the fragment binds.
 */
export function rootReadableWithoutMembershipSql(
  workspaceId: string,
  userId: string | QueryConfig,
  rootAlias: string
): QueryConfig {
  const root = sql`${sql.raw(rootAlias)}`
  return composeSql`(
    ${root}.visibility = ${Visibilities.GUEST_PUBLIC}
    OR (${root}.visibility = ${Visibilities.PUBLIC} AND NOT ${viewerLacksBrowseSql(workspaceId, userId)})
  )`
}

/**
 * The canonical "is this *already-resolved effective root* readable by the
 * user?" leaf: readable without membership ({@link rootReadableWithoutMembershipSql})
 * OR a `stream_members` row on the root. This is
 * the single rule that both the per-id predicate ({@link streamAccessPredicateSql})
 * and the workspace catch-up CTE (`features/sync/repository.ts`) reduce a
 * stream's effective root down to — extracted so the open-without-membership
 * branch cannot live in one and be silently dropped from the other (catch-up
 * replicating the thread→root leg while omitting the public-root leg is the
 * drift this guards against). The caller resolves the effective root
 * (top-level stream → itself, thread → its root) and passes its alias; this
 * fragment only decides readability of that resolved root.
 *
 * `rootAlias` is injected raw (squid `raw`) because it is a SQL alias reference,
 * not a value — it MUST be a trusted constant supplied by call-site code (e.g.
 * `"eff_root"`), NEVER derived from user input. Built with {@link composeSql} so it
 * carries `$1..$k` placeholders that composeSql renumbers when splicing
 * it into a larger query. A `QueryConfig` `userId` must not name `u`, `wup` or
 * `stream_members`, which the fragment binds.
 */
export function rootReadableConditionSql(
  workspaceId: string,
  userId: string | QueryConfig,
  rootAlias: string
): QueryConfig {
  const root = sql`${sql.raw(rootAlias)}`
  return composeSql`(
    ${rootReadableWithoutMembershipSql(workspaceId, userId, rootAlias)}
    OR EXISTS (
      SELECT 1 FROM stream_members
      WHERE workspace_id = ${workspaceId} AND stream_id = ${root}.id AND member_id = ${userId}
    )
  )`
}

/**
 * Canonical SQL predicate for the "thread → root" stream-access rule
 * (INV-62), as a reusable `EXISTS` fragment correlated to a stream-id
 * column, and the single source of truth for stream read access
 * (`checkStreamAccess` and `listAccessibleStreamIds` run it). The effective
 * root is resolved with `COALESCE(root_stream_id, id)` (a top-level stream is
 * its own root, a thread defers to its root; a thread whose root row is
 * missing finds no join and is denied), then {@link rootReadableConditionSql}
 * decides readability — the same leaf the catch-up CTE applies, so the two
 * cannot drift.
 *
 * A doc is also readable through a `shared_docs` grant: an undeleted message
 * carrying its chip sits in a stream whose root passes the same leaf. That leg
 * is not recursive (a grant never flows through another grant), and the
 * catch-up CTE does not apply it. `options.docGrants: false` drops the leg.
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
 *
 * `userId` is an id, or a `QueryConfig` column reference correlating the
 * predicate to an outer row's user. It must not name an alias the fragment
 * binds (`u`, `wup`, `stream_members`, `eff_s`, `eff_root`, `sd`, `sd_m`, `sd_s`,
 * `sd_root`), or it matches the fragment's own row.
 */
export function streamAccessPredicateSql(
  workspaceId: string,
  userId: string | QueryConfig,
  streamIdColumn: string,
  options?: StreamAccessOptions
): QueryConfig {
  const docGrantSql =
    options?.docGrants === false
      ? sql`FALSE`
      : composeSql`(
          eff_s.type = ${StreamTypes.DOC}
          AND EXISTS (
            SELECT 1
            FROM shared_docs sd
            JOIN messages sd_m ON sd_m.workspace_id = sd.workspace_id AND sd_m.id = sd.share_message_id
              AND sd_m.deleted_at IS NULL
            JOIN streams sd_s ON sd_s.id = sd_m.stream_id AND sd_s.workspace_id = sd.workspace_id
            JOIN streams sd_root ON sd_root.id = COALESCE(sd_s.root_stream_id, sd_s.id)
              AND sd_root.workspace_id = sd.workspace_id
            WHERE sd.workspace_id = ${workspaceId}
              AND sd.doc_id = eff_s.id
              AND ${rootReadableConditionSql(workspaceId, userId, "sd_root")}
          )
        )`
  return composeSql`EXISTS (
    SELECT 1
    FROM streams eff_s
    JOIN streams eff_root ON eff_root.id = COALESCE(eff_s.root_stream_id, eff_s.id)
      AND eff_root.workspace_id = eff_s.workspace_id
    WHERE ${sql`eff_s.id = ${sql.raw(streamIdColumn)}`}
      AND eff_s.workspace_id = ${workspaceId}
      AND eff_root.workspace_id = ${workspaceId}
      AND (
        ${rootReadableConditionSql(workspaceId, userId, "eff_root")}
        OR ${docGrantSql}
      )
  )`
}

/**
 * True when no reader of `roomStreamId`'s room lacks browse: the room's root is not `guest_public`
 * (whose readers include every workspace user, so it is taken to hold a guest without looking) and
 * none of its members lacks browse. A missing room has no root to vet, so it is false.
 */
export function roomReadersAllBrowseSql(workspaceId: string, roomStreamId: string | QueryConfig): QueryConfig {
  return composeSql`EXISTS (
    SELECT 1
    FROM streams room
    JOIN streams room_root ON room_root.id = COALESCE(room.root_stream_id, room.id)
      AND room_root.workspace_id = room.workspace_id
    WHERE room.workspace_id = ${workspaceId}
      AND room.id = ${roomStreamId}
      AND room_root.visibility <> ${Visibilities.GUEST_PUBLIC}
      AND NOT ${anyUserLacksBrowseSql(
        workspaceId,
        sql`SELECT rm.member_id FROM stream_members rm WHERE rm.workspace_id = ${workspaceId} AND rm.stream_id = room_root.id`
      )}
  )`
}

/**
 * Room-uniform readability for a payload delivered to everyone in `roomStreamId`'s room: a reader
 * of the room's root is any member of it, plus every workspace user when it is `guest_public`.
 * `guest_public` content is readable by all of them; `public` content only when no reader lacks
 * browse ({@link roomReadersAllBrowseSql}), so a `guest_public` or missing room lets only
 * `guest_public` through. `rootAlias` is a trusted SQL alias for the content's effective root,
 * never user input.
 */
export function roomReadableWithoutMembershipSql(
  workspaceId: string,
  roomStreamId: string | QueryConfig,
  rootAlias: string
): QueryConfig {
  const root = sql`${sql.raw(rootAlias)}`
  return composeSql`(
    ${root}.visibility = ${Visibilities.GUEST_PUBLIC}
    OR (${root}.visibility = ${Visibilities.PUBLIC} AND ${roomReadersAllBrowseSql(workspaceId, roomStreamId)})
  )`
}

/**
 * True when another workspace reads `roomStreamId`'s room: its root is a copy of another workspace's
 * channel, or this workspace actively shares it. Those readers see only the shared tree, so an agent
 * answering there may read no further. A missing room is false.
 */
export function roomSharedSql(workspaceId: string, roomStreamId: string): QueryConfig {
  return sql`EXISTS (
    SELECT 1
    FROM streams room
    JOIN streams room_root ON room_root.id = COALESCE(room.root_stream_id, room.id)
      AND room_root.workspace_id = room.workspace_id
    WHERE room.workspace_id = ${workspaceId}
      AND room.id = ${roomStreamId}
      AND (
        room_root.origin_workspace_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM stream_connections sc
          WHERE sc.workspace_id = room_root.workspace_id AND sc.stream_id = room_root.id
            AND sc.role = 'host' AND sc.state = 'active'
        )
      )
  )`
}

export async function isRoomShared(db: Querier, workspaceId: string, roomStreamId: string): Promise<boolean> {
  const result = await db.query<{ shared: boolean }>(
    composeSql`SELECT ${roomSharedSql(workspaceId, roomStreamId)} AS shared`
  )
  return result.rows[0]?.shared ?? false
}

/**
 * Room-uniform readability: the subset of candidate stream ids in the workspace that every reader
 * of the room can read — the room stream itself, plus candidates whose effective root (thread →
 * root via `COALESCE(root_stream_id, id)`) passes {@link roomReadableWithoutMembershipSql}. No
 * viewer: a per-user membership grant is meaningless for a payload delivered to everyone in the
 * room. The room root's own members still decide whether `public` content passes.
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
  const result = await db.query<{ id: string }>(composeSql`
    SELECT s.id
    FROM streams s
    JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id) AND root.workspace_id = s.workspace_id
    WHERE s.workspace_id = ${workspaceId}
      AND s.id = ANY(${candidateStreamIds as string[]})
      AND (s.id = ${roomStreamId} OR ${roomReadableWithoutMembershipSql(workspaceId, roomStreamId, "root")})
  `)
  return new Set(result.rows.map((r) => r.id))
}

/**
 * Batched equivalent of {@link checkStreamAccess}. Given a candidate set
 * of stream ids in a workspace, returns the subset the viewer can read.
 *
 * Routes through {@link streamAccessPredicateSql} so the access rule
 * (thread → root, doc grants) has exactly one definition shared with the
 * cross-cutting features (search, attachments) that filter many stream ids
 * at once without an N+1.
 *
 * Empty input → empty Set; missing/cross-workspace ids are silently dropped
 * exactly like the per-id helper returning `null`.
 */
export async function listAccessibleStreamIds(
  db: Querier,
  workspaceId: string,
  userId: string,
  candidateStreamIds: readonly string[],
  options?: StreamAccessOptions
): Promise<Set<string>> {
  if (candidateStreamIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(composeSql`
    SELECT s.id
    FROM streams s
    WHERE s.workspace_id = ${workspaceId}
      AND s.id = ANY(${candidateStreamIds as string[]})
      AND ${streamAccessPredicateSql(workspaceId, userId, "s.id", options)}
  `)
  return new Set(result.rows.map((r) => r.id))
}

/** Which of `userIds` (workspace users) can read `streamId`, by the same predicate as {@link checkStreamAccess}. */
export async function listUsersWithStreamAccess(
  db: Querier,
  workspaceId: string,
  streamId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(composeSql`
    SELECT reader.id
    FROM users reader
    CROSS JOIN (SELECT ${streamId}::text AS id) target
    WHERE reader.workspace_id = ${workspaceId}
      AND reader.id = ANY(${userIds as string[]})
      AND ${streamAccessPredicateSql(workspaceId, sql`reader.id`, "target.id")}
  `)
  return new Set(result.rows.map((r) => r.id))
}

/**
 * Which of `userIds` read a stream of this `visibility` without a `stream_members` row, for gates
 * that decide in TypeScript. The SQL form of the same rule is {@link rootReadableWithoutMembershipSql}.
 * Pass the effective root's visibility; an unknown value reads for no one.
 */
export async function usersReadingWithoutMembership(
  db: Querier,
  workspaceId: string,
  visibility: Visibility,
  userIds: readonly string[]
): Promise<Set<string>> {
  switch (visibility) {
    case Visibilities.GUEST_PUBLIC:
      return new Set(userIds)
    case Visibilities.PUBLIC: {
      const lacking = await findUserIdsWithoutBrowse(db, workspaceId, userIds)
      return new Set(userIds.filter((userId) => !lacking.has(userId)))
    }
    default:
      return new Set()
  }
}

export type ReaderScope = { streamId: string } | { userIds: readonly string[] }

/**
 * Per source stream, which readers lack access to it: the readers of `scope.streamId`, or the
 * given `scope.userIds`. Both sides run {@link streamAccessPredicateSql}, so thread → root and
 * open-channel readers without a `stream_members` row count. `count` covers every exposed reader;
 * with `sample`, `sampleUserIds` holds up to `sample.size` of them visible to `sample.viewerId`,
 * ordered by name, else it is empty. Sources nobody is exposed to are absent; empty input → empty
 * Map. A missing or cross-workspace source is readable by no one, so it counts every reader; pass
 * distinct ids.
 */
export async function findReadersWithoutAccess(
  db: Querier,
  workspaceId: string,
  scope: ReaderScope,
  sourceStreamIds: readonly string[],
  sample?: { size: number; viewerId: string }
): Promise<Map<string, { count: number; sampleUserIds: string[] }>> {
  if (sourceStreamIds.length === 0) return new Map()
  const reader = sql`reader.id`
  const readerFilter =
    "streamId" in scope
      ? composeSql`EXISTS (
          SELECT 1 FROM streams tgt
          WHERE tgt.workspace_id = ${workspaceId}
            AND tgt.id = ${scope.streamId}
            AND ${streamAccessPredicateSql(workspaceId, reader, "tgt.id")}
        )`
      : composeSql`reader.id = ANY(${scope.userIds as string[]})`
  const visibleSql = sample
    ? composeSql`EXISTS (
        SELECT 1 FROM users u
        WHERE u.workspace_id = ${workspaceId}
          AND u.id = reader.id
          AND ${peopleScopeSql(workspaceId, {
            viewer: { kind: "user", userId: sample.viewerId },
            purpose: PeoplePurposes.VISIBLE,
          })}
      )`
    : sql`FALSE`
  const result = await db.query<{ stream_id: string; count: number; sample_user_ids: string[] }>(composeSql`
    WITH scoped AS (
      SELECT reader.id, reader.name, ${visibleSql} AS visible FROM users reader
      WHERE reader.workspace_id = ${workspaceId} AND ${readerFilter}
    )
    SELECT src.id AS stream_id, COUNT(*)::int AS count,
      COALESCE(
        (array_agg(reader.id ORDER BY reader.name, reader.id) FILTER (WHERE reader.visible))[1:${sample?.size ?? 0}::int],
        '{}'
      ) AS sample_user_ids
    FROM unnest(${sourceStreamIds as string[]}::text[]) AS src(id)
    CROSS JOIN scoped reader
    WHERE NOT ${streamAccessPredicateSql(workspaceId, reader, "src.id")}
    GROUP BY src.id
  `)
  return new Map(result.rows.map((row) => [row.stream_id, { count: row.count, sampleUserIds: row.sample_user_ids }]))
}
