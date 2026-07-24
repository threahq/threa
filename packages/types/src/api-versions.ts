/**
 * Dated public API versions for the `Threa-Version` header, ascending. The
 * first entry is the epoch. Single source of truth shared by the backend
 * versioning module and the frontend key-pin UI — do not fork this list.
 */
export const API_VERSIONS = ["2026-07-12", "2026-07-22", "2026-07-24"] as const
export type ApiVersion = (typeof API_VERSIONS)[number]
export const CURRENT_API_VERSION: ApiVersion = API_VERSIONS[API_VERSIONS.length - 1]
