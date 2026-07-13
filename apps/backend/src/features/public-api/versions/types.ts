import type { OperationId } from "../routes"
import { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion } from "@threa/types"

// Version list lives in @threa/types so the frontend key-pin UI shares one
// source of truth; the change-registry machinery below stays backend-only
// because it references OperationId.
export { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion }

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
