import type { OperationId } from "../routes"

/** Dated public API versions, ascending. The first entry is the epoch. */
export const API_VERSIONS = ["2026-07-12"] as const
export type ApiVersion = (typeof API_VERSIONS)[number]
export const CURRENT_API_VERSION: ApiVersion = API_VERSIONS[API_VERSIONS.length - 1]

export interface VersionChangeContext {
  operationId: OperationId
}

/**
 * One dated, breaking change. `version` is the date the NEW behavior became
 * default; callers pinned BEFORE it get the transforms applied. Transforms
 * translate between this version's shape and the previous one: upgradeRequest
 * lifts an old-shape request to the new shape, downgradeResponse lowers a
 * new-shape payload to the old shape. Both must be pure.
 */
export interface VersionChange {
  version: ApiVersion
  /** One-line summary for the generated CHANGELOG. */
  description: string
  /** Operations whose requests/responses this change touches. */
  operations: ReadonlySet<OperationId>
  upgradeRequest?: (body: unknown, ctx: VersionChangeContext) => unknown
  downgradeResponse?: (payload: unknown, ctx: VersionChangeContext) => unknown
}
