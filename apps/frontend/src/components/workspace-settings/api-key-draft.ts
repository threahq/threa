import { API_KEY_ELIGIBLE_PICKER_SCOPES, CURRENT_API_VERSION, type WorkspacePermissionSlug } from "@threahq/types"

const PICKABLE_SCOPES = new Set<string>(API_KEY_ELIGIBLE_PICKER_SCOPES.map((p) => p.slug))
// Mirrors the backend's key name limit, so a long name still fits once suffixed.
const NAME_MAX_LENGTH = 100
const COPY_SUFFIX = " (copy)"

export interface ApiKeyDraft {
  name: string
  scopes: Set<WorkspacePermissionSlug>
  apiVersion: string | null
  /** Source scopes a new key can no longer be granted. */
  droppedScopes: string[]
}

export const EMPTY_API_KEY_DRAFT: ApiKeyDraft = {
  name: "",
  scopes: new Set(),
  apiVersion: CURRENT_API_VERSION,
  droppedScopes: [],
}

export function draftFromKey(key: { name: string; scopes: readonly string[]; apiVersion: string | null }): ApiKeyDraft {
  return {
    name: key.name.slice(0, NAME_MAX_LENGTH - COPY_SUFFIX.length) + COPY_SUFFIX,
    scopes: new Set(key.scopes.filter((scope) => PICKABLE_SCOPES.has(scope)) as WorkspacePermissionSlug[]),
    apiVersion: key.apiVersion,
    droppedScopes: key.scopes.filter((scope) => !PICKABLE_SCOPES.has(scope)),
  }
}
