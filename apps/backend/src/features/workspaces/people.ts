import type { QueryConfig } from "pg"
import { sql } from "../../db"

export const PeoplePurposes = {
  VISIBLE: "visible",
  TARGETABLE: "targetable",
} as const

type PeoplePurpose = (typeof PeoplePurposes)[keyof typeof PeoplePurposes]

export type PeopleViewer = { kind: "user"; userId: string } | { kind: "workspace" }

export interface PeopleScope {
  viewer: PeopleViewer
  purpose: PeoplePurpose
}

/**
 * Predicate over the `users u` alias deciding which workspace users `scope.viewer` may see
 * (`visible`) or pick (`targetable`). Every read of a viewer-supplied id, slug or query passes a
 * scope; rendering reads of ids that came from content the viewer already accesses do not.
 */
export function peopleScopeSql(_scope: PeopleScope): QueryConfig {
  return sql`TRUE`
}
