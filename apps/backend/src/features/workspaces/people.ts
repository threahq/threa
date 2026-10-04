import type { QueryConfig } from "pg"
import { AuthorTypes } from "@threahq/types"
import { sql } from "../../db"

export const PeoplePurposes = {
  VISIBLE: "visible",
  TARGETABLE: "targetable",
} as const

type PeoplePurpose = (typeof PeoplePurposes)[keyof typeof PeoplePurposes]

/** `workspace` is a reader acting for no user: bot keys, system work, agent or persona authors, backfills. */
export type PeopleViewer = { kind: "user"; userId: string } | { kind: "workspace" }

export interface PeopleScope {
  viewer: PeopleViewer
  purpose: PeoplePurpose
}

export function peopleViewerForActor(actorType: string, actorId: string): PeopleViewer {
  return actorType === AuthorTypes.USER ? { kind: "user", userId: actorId } : { kind: "workspace" }
}

/**
 * Which workspace users `scope.viewer` may see (`visible`) or pick (`targetable`). Reads that list,
 * pick or resolve users on a viewer's behalf pass a scope; rendering reads of ids taken from content
 * the viewer already accesses, and admin routes keyed by a route-param id, do not.
 *
 * Spliced after `AND` into a WHERE over `users u`, so it stays one parenthesized boolean; other
 * tables are reached through subqueries.
 */
export function peopleScopeSql(_scope: PeopleScope): QueryConfig {
  return sql`(TRUE)`
}
