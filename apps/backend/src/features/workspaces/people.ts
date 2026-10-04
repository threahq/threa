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

/** One row per stream and its member or non-deleted author; bot and persona ids match no user row. */
function streamPeopleSql(workspaceId: string): QueryConfig {
  return composeSql`
    SELECT sm.stream_id, sm.member_id AS person_id FROM stream_members sm WHERE sm.workspace_id = ${workspaceId}
    UNION ALL
    SELECT m.stream_id, m.author_id FROM messages m WHERE m.workspace_id = ${workspaceId} AND m.deleted_at IS NULL`
}

function peopleOfStreamsSql(workspaceId: string, streamIdsSql: QueryConfig): QueryConfig {
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

/** The users lacking browse, other than `userId`, who see `userId` by `peopleScopeSql`'s user arm. */
export async function listGuestViewerIds(db: Querier, workspaceId: string, userId: string): Promise<string[]> {
  const guestId = sql`${sql.raw("g.id")}`
  // eslint-disable-next-line threa/workspace-scoped-sql -- streamPeopleSql pins workspace_id in both arms, checked where it is written
  const result = await db.query<{ id: string }>(composeSql`
    WITH subject_streams AS MATERIALIZED (
      SELECT DISTINCT sp.stream_id FROM (${streamPeopleSql(workspaceId)}) sp WHERE sp.person_id = ${userId}
    ),
    guests AS (${userIdsLackingBrowseSql(workspaceId)})
    SELECT g.id FROM guests g
    WHERE g.id <> ${userId}
      AND EXISTS (
        SELECT 1 FROM subject_streams ss WHERE ${streamAccessPredicateSql(workspaceId, guestId, "ss.stream_id")}
      )
  `)
  return result.rows.map((row) => row.id)
}
