import { HttpError } from "@threa/backend-common"
import { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion, type VersionChange } from "./types"

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

export { API_VERSIONS, CURRENT_API_VERSION }
export type { ApiVersion, VersionChange, VersionChangeContext } from "./types"
