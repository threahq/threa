import type { OperationId } from "../routes"

/** Dated public API versions, ascending. The first entry is the epoch. */
export const API_VERSIONS = ["2026-07-12"] as const
export type ApiVersion = (typeof API_VERSIONS)[number]
export const CURRENT_API_VERSION: ApiVersion = API_VERSIONS[API_VERSIONS.length - 1]

export interface VersionChangeContext {
  operationId: OperationId
}

/** A parsed OpenAPI 3.0 document, as the generator builds and serializes it. */
export type OpenApiSpec = Record<string, unknown>

/**
 * One dated, breaking change. `version` is the date the NEW behavior became
 * default; callers pinned BEFORE it get the transforms applied. Transforms
 * translate between this version's shape and the previous one: upgradeRequest
 * lifts an old-shape request to the new shape, downgradeResponse lowers a
 * new-shape payload to the old shape. Both must be pure.
 *
 * `downgradeSpec` is the documentation analog of `downgradeResponse`: it lowers
 * the whole OpenAPI document from this version's shape to the previous one. The
 * generator derives each older version's spec from the current one by applying
 * these hooks newest→oldest, exactly as the request path applies
 * `downgradeResponse` to a behind-version caller's payload. It must be pure and
 * operate on a clone (the generator hands it one). With no `downgradeSpec` a
 * change leaves the spec untouched, so a version whose changes are all
 * request-only or documentation-neutral still emits a correct spec that differs
 * from the current one by `info.version` alone.
 */
export interface VersionChange {
  version: ApiVersion
  /** One-line summary for the generated CHANGELOG. */
  description: string
  /** Operations whose requests/responses this change touches. */
  operations: ReadonlySet<OperationId>
  upgradeRequest?: (body: unknown, ctx: VersionChangeContext) => unknown
  downgradeResponse?: (payload: unknown, ctx: VersionChangeContext) => unknown
  downgradeSpec?: (spec: OpenApiSpec) => OpenApiSpec
}
