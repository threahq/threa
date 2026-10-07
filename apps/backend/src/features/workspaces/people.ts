import type { QueryConfig } from "pg"
import { AuthorTypes } from "@threahq/types"
import { composeSql, sql, type Querier } from "../../db"
import {
  roomReadableWithoutMembershipSql,
  roomReadersAllBrowseSql,
  roomSharedSql,
  streamAccessPredicateSql,
} from "../streams"
import { userIdsLackingBrowseSql, viewerLacksBrowseSql } from "./viewer-browse"

export const PeoplePurposes = {
  VISIBLE: "visible",
  TARGETABLE: "targetable",
} as const

type PeoplePurpose = (typeof PeoplePurposes)[keyof typeof PeoplePurposes]

/**
 * `room` is an agent answering everyone in a stream's room, so it sees what every reader of that room
 * could. `workspace` is a reader acting for no user: bot keys, system work, agent or persona authors,
 * backfills.
 */
export type PeopleViewer =
  | { kind: "user"; userId: string }
  | { kind: "room"; roomStreamId: string }
  | { kind: "workspace" }

export interface PeopleScope {
  viewer: PeopleViewer
  purpose: PeoplePurpose
}

export function peopleViewerForActor(actorType: string, actorId: string): PeopleViewer {
  return actorType === AuthorTypes.USER ? { kind: "user", userId: actorId } : { kind: "workspace" }
}

/**
 * `(stream_id, person_id)` rows, one per membership and per non-deleted message, so callers dedupe;
 * bot and persona ids match no user row.
 */
function streamPeopleSql(workspaceId: string): QueryConfig {
  return composeSql`
    SELECT sm.stream_id, sm.member_id AS person_id FROM stream_members sm WHERE sm.workspace_id = ${workspaceId}
    UNION ALL
    SELECT m.stream_id, m.author_id FROM messages m WHERE m.workspace_id = ${workspaceId} AND m.deleted_at IS NULL`
}

/** `u.id IN (…)`: the members and authors of the streams `streamIdsSql` selects. */
export function peopleOfStreamsSql(workspaceId: string, streamIdsSql: QueryConfig): QueryConfig {
  // eslint-disable-next-line threa/workspace-scoped-sql -- streamPeopleSql pins workspace_id in both arms, checked where it is written
  return composeSql`u.id IN (
    SELECT sp.person_id FROM (${streamPeopleSql(workspaceId)}) sp WHERE sp.stream_id IN (${streamIdsSql})
  )`
}

/**
 * Which workspace users `scope.viewer` may see (`visible`) or pick (`targetable`). Reads that list,
 * pick or resolve users on a viewer's behalf pass a scope; rendering reads of ids taken from content
 * the viewer already accesses, and admin routes keyed by a route-param id, do not.
 *
 * A viewer with browse sees everyone. A viewer without it (a guest) sees themselves plus the members
 * and authors of the streams they read, by the single stream access rule (INV-62). A room viewer sees
 * everyone when no reader of the room lacks browse, else the members and authors of the room's root
 * and its threads plus the `guest_public` roots every reader reads. A thread room is its root's room.
 *
 * Spliced after `AND` into a WHERE over `users u`, so it stays one parenthesized boolean; other
 * tables are reached through subqueries.
 */
export function peopleScopeSql(workspaceId: string, scope: PeopleScope): QueryConfig {
  const visible = visibleToViewerSql(workspaceId, scope.viewer)
  // A shared channel's copy of a host user shows who wrote and reacted there, but nobody here can reach them.
  return scope.purpose === PeoplePurposes.TARGETABLE
    ? composeSql`(u.origin_workspace_id IS NULL AND ${visible})`
    : visible
}

function visibleToViewerSql(workspaceId: string, viewer: PeopleViewer): QueryConfig {
  switch (viewer.kind) {
    case "workspace":
      return sql`(TRUE)`
    case "user":
      return composeSql`(
        NOT ${viewerLacksBrowseSql(workspaceId, viewer.userId)}
        OR u.id = ${viewer.userId}
        OR ${peopleOfStreamsSql(
          workspaceId,
          composeSql`SELECT s.id FROM streams s
            WHERE s.workspace_id = ${workspaceId} AND ${streamAccessPredicateSql(workspaceId, viewer.userId, "s.id")}`
        )}
      )`
    case "room": {
      const unshared = composeSql`NOT ${roomSharedSql(workspaceId, viewer.roomStreamId)}`
      return composeSql`(
        (${unshared} AND ${roomReadersAllBrowseSql(workspaceId, viewer.roomStreamId)})
        OR ${peopleOfStreamsSql(
          workspaceId,
          composeSql`SELECT s.id FROM streams s
            JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id) AND root.workspace_id = s.workspace_id
            WHERE s.workspace_id = ${workspaceId}
              AND (root.id = (SELECT COALESCE(room.root_stream_id, room.id) FROM streams room
                  WHERE room.workspace_id = ${workspaceId} AND room.id = ${viewer.roomStreamId})
                OR (${unshared} AND ${roomReadableWithoutMembershipSql(workspaceId, viewer.roomStreamId, "root")}))`
        )}
      )`
    }
  }
}

/** For each of `userIds`, the users lacking browse, other than that user, who see it by `peopleScopeSql`'s user arm. */
export async function listGuestViewers(
  db: Querier,
  workspaceId: string,
  userIds: readonly string[]
): Promise<Map<string, string[]>> {
  const viewers = new Map<string, string[]>()
  if (userIds.length === 0) return viewers
  // A thread is read through its root (INV-62), so each person's streams collapse to roots; a
  // workspace without guests skips the people scan through the one-time EXISTS filter.
  // eslint-disable-next-line threa/workspace-scoped-sql -- streamPeopleSql pins workspace_id in both arms, checked where it is written
  const result = await db.query<{ subject_id: string; id: string }>(composeSql`
    WITH guests AS (${userIdsLackingBrowseSql(workspaceId)}),
    subject_roots AS MATERIALIZED (
      SELECT DISTINCT sp.person_id AS subject_id, COALESCE(s.root_stream_id, s.id) AS root_id
      FROM (${streamPeopleSql(workspaceId)}) sp
      JOIN streams s ON s.id = sp.stream_id AND s.workspace_id = ${workspaceId}
      WHERE sp.person_id = ANY(${userIds as string[]}) AND EXISTS (SELECT 1 FROM guests)
    )
    SELECT s.subject_id, g.id FROM (SELECT DISTINCT subject_id FROM subject_roots) s
    JOIN guests g ON g.id <> s.subject_id
    WHERE EXISTS (
      SELECT 1 FROM subject_roots sr
      WHERE sr.subject_id = s.subject_id AND ${streamAccessPredicateSql(workspaceId, sql`g.id`, "sr.root_id")}
    )
  `)
  for (const row of result.rows) {
    const ids = viewers.get(row.subject_id)
    if (ids) ids.push(row.id)
    else viewers.set(row.subject_id, [row.id])
  }
  return viewers
}
