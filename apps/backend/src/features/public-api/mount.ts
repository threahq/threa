import { PUBLIC_API_ROUTES } from "./routes"

/** Convert an OpenAPI path template (`{param}`) to an Express path (`:param`). */
export function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ":$1")
}

/**
 * Throws if the handler map and the route registry disagree: a registry route
 * with no handler, or a handler for an operation the registry never declares.
 * The registry is the SSOT (it also generates the OpenAPI spec); this keeps the
 * hand-written handler map from silently drifting out of sync at boot.
 */
export function assertHandlerParity(handlerOperationIds: Iterable<string>): void {
  const registryIds = new Set<string>(PUBLIC_API_ROUTES.map((route) => route.operationId))
  const handlerIds = new Set<string>(handlerOperationIds)

  const missing = [...registryIds].filter((id) => !handlerIds.has(id))
  if (missing.length > 0) {
    throw new Error(`Public API routes missing handlers: ${missing.join(", ")}`)
  }

  const extra = [...handlerIds].filter((id) => !registryIds.has(id))
  if (extra.length > 0) {
    throw new Error(`Public API handlers without a registry route: ${extra.join(", ")}`)
  }
}
