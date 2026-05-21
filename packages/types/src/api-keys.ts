import {
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_PERMISSIONS,
  type WorkspacePermission,
  type WorkspacePermissionSlug,
} from "./workspace-permissions"

// API-key scopes draw from the same catalog as workspace permissions; persisted
// keys are clamped at request time against the owner's effective workspace
// permissions in the regional middleware.

/**
 * Slugs that may be selected when creating a user or bot API key. This is a
 * subset of the workspace permission catalog: admin/owner-gated slugs
 * (`workspace:*`, `members:write`, `bots:manage`, `bots:create:shared`) are
 * deliberately excluded until request-time clamping is wired up — without the
 * clamp, a member could persist a key that names a scope they don't actually
 * hold. Once the regional clamp ships, this subset can grow (or be removed
 * entirely in favor of the full catalog).
 */
export const API_KEY_ELIGIBLE_SCOPES: readonly [WorkspacePermissionSlug, ...WorkspacePermissionSlug[]] = [
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH,
  WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
  WORKSPACE_PERMISSION_SCOPES.USERS_READ,
  WORKSPACE_PERMISSION_SCOPES.MEMOS_READ,
  WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
  WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_READ,
  WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
  WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_READ,
  WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
]

const ELIGIBLE_SCOPE_SET: ReadonlySet<WorkspacePermissionSlug> = new Set(API_KEY_ELIGIBLE_SCOPES)

/**
 * `WorkspacePermission` records (slug + name + description) for the eligible
 * subset, in catalog order. Frontend pickers render from this so the picker UI
 * stays a one-line consumer of the source of truth.
 */
export const API_KEY_ELIGIBLE_PICKER_SCOPES: readonly WorkspacePermission[] = WORKSPACE_PERMISSIONS.filter((p) =>
  ELIGIBLE_SCOPE_SET.has(p.slug)
)

// --- User-scoped API keys ---

/** Prefix for sentVia field on messages created through user-scoped API keys */
export const SENT_VIA_API_PREFIX = "api_key:" as const

/** Build the sentVia value for a user-scoped API key */
export function sentViaApiKey(keyId: string): string {
  return `${SENT_VIA_API_PREFIX}${keyId}`
}

/** Check if a sentVia value indicates it was sent via a user-scoped API key */
export function isSentViaApi(sentVia: string | null): boolean {
  return sentVia != null && sentVia.startsWith(SENT_VIA_API_PREFIX)
}

/** Wire format for user API keys (returned to frontend, key value never included) */
export interface UserApiKey {
  id: string
  name: string
  keyPrefix: string
  scopes: WorkspacePermissionSlug[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Response when creating a user API key (includes the full key value once) */
export interface CreateUserApiKeyResponse {
  key: UserApiKey
  /** The full API key value. Only returned on creation — store it securely. */
  value: string
}

// --- Bot API keys ---

export const BOT_KEY_PREFIX = "threa_bk_" as const

/** Wire format for bot API keys (returned to frontend, key value never included) */
export interface BotApiKey {
  id: string
  botId: string
  name: string
  keyPrefix: string
  scopes: WorkspacePermissionSlug[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Response when creating a bot API key (includes the full key value once) */
export interface CreateBotApiKeyResponse {
  key: BotApiKey
  /** The full API key value. Only returned on creation — store it securely. */
  value: string
}
