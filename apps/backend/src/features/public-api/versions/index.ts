import { HttpError } from "@threa/backend-common"
import { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion, type OpenApiSpec, type VersionChange } from "./types"

/** Ascending by version. Startup assertion enforces ordering + known dates. */
export const VERSION_CHANGES: VersionChange[] = [
  // Populated when the first real breaking change ships (see design doc §8).
]

/** Throws unless every change is strictly newer than the one before it. */
export function assertChangesAscending(changes: readonly VersionChange[]): void {
  for (let i = 1; i < changes.length; i++) {
    if (changes[i - 1].version >= changes[i].version) {
      throw new Error("VERSION_CHANGES must be strictly ascending by version")
    }
  }
}

assertChangesAscending(VERSION_CHANGES)

const KNOWN = new Set<string>(API_VERSIONS)

export function parseApiVersion(raw: string): ApiVersion {
  if (!KNOWN.has(raw)) {
    throw new HttpError(`Unknown API version "${raw}". Known versions: ${API_VERSIONS.join(", ")}`, {
      status: 400,
      code: "INVALID_API_VERSION",
    })
  }
  return raw as ApiVersion
}

/** Changes the caller is behind on, i.e. with version strictly newer than theirs. */
export function changesAfter(clientVersion: ApiVersion, changes: readonly VersionChange[] = VERSION_CHANGES) {
  // ISO dates compare lexicographically — no Date parsing.
  return changes.filter((c) => c.version > clientVersion)
}

/**
 * Derives the OpenAPI spec as it stood at `version` from the current-version
 * `canonical` spec. Applies each newer change's `downgradeSpec` newest→oldest —
 * the same order and predicate the request path uses for `downgradeResponse`
 * (see middleware/api-version.ts) — then stamps `info.version`. Operates on a
 * clone, so the canonical spec is never mutated. The documentation analog of the
 * runtime response downgrade; the OpenAPI generator uses it to emit one spec per
 * version.
 */
export function deriveVersionSpec(
  canonical: OpenApiSpec,
  version: ApiVersion,
  changes: readonly VersionChange[] = VERSION_CHANGES
): OpenApiSpec {
  const pending = changesAfter(version, changes)
  let spec = structuredClone(canonical)
  for (let i = pending.length - 1; i >= 0; i--) {
    const change = pending[i]
    if (change.downgradeSpec) spec = change.downgradeSpec(spec)
  }
  spec.info = { ...(spec.info as Record<string, unknown>), version }
  return spec
}

export { API_VERSIONS, CURRENT_API_VERSION }
export type { ApiVersion, OpenApiSpec, VersionChange, VersionChangeContext } from "./types"
