/**
 * Workspace authorization catalog — single source of truth for the WorkOS
 * dashboard sync (`scripts/sync-workos-permissions.ts`), regional
 * `requireWorkspacePermission(slug)` middleware, and the API-key scope picker.
 */

export const WORKSPACE_PERMISSION_SCOPES = {
  MESSAGES_SEARCH: "messages:search",
  STREAMS_READ: "streams:read",
  MESSAGES_READ: "messages:read",
  MESSAGES_WRITE: "messages:write",
  USERS_READ: "users:read",
  MEMOS_READ: "memos:read",
  ATTACHMENTS_READ: "attachments:read",
  ATTACHMENTS_WRITE: "attachments:write",
  BOTS_CREATE_PERSONAL: "bots:create:personal",
  BOTS_CREATE_SHARED: "bots:create:shared",
  BOTS_MANAGE: "bots:manage",
  BOT_RUNTIME_READ: "bot-runtime:read",
  BOT_RUNTIME_WRITE: "bot-runtime:write",
  BOT_INVOCATIONS_READ: "bot-invocations:read",
  BOT_INVOCATIONS_WRITE: "bot-invocations:write",
  MEMBERS_WRITE: "members:write",
  WORKSPACE_ADMIN: "workspace:admin",
  WORKSPACE_OWNER: "workspace:owner",
} as const

export type WorkspacePermissionSlug = (typeof WORKSPACE_PERMISSION_SCOPES)[keyof typeof WORKSPACE_PERMISSION_SCOPES]

export interface WorkspacePermission {
  readonly slug: WorkspacePermissionSlug
  readonly name: string
  readonly description: string
}

/**
 * The full permission catalog. Order is the wire ordering used by the WorkOS
 * sync script and the frontend scope picker.
 */
export const WORKSPACE_PERMISSIONS: readonly WorkspacePermission[] = Object.freeze([
  {
    slug: WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH,
    name: "Search messages",
    description:
      "Grants access to search messages in public streams in a workspace. Application level stream grants can extend permissions to private streams.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
    name: "Read streams",
    description: "Grants access to list and search accessible streams in a workspace.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
    name: "Read messages",
    description: "Grants access to read messages in accessible streams.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
    name: "Write messages",
    description: "Grants access to send, update, and delete messages in accessible streams.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.USERS_READ,
    name: "Read users",
    description: "Grants access to list and search workspace users.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.MEMOS_READ,
    name: "Read memos",
    description: "Grants access to search preserved workspace memos and inspect their provenance.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
    name: "Read attachments",
    description: "Grants access to search accessible attachments, inspect extracted content, and fetch download URLs.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE,
    name: "Upload attachments",
    description: "Grants access to upload and replace attachments in accessible streams.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL,
    name: "Create personal bots",
    description:
      "Grants access to create personal bots that act on the creator's behalf. Revoke this on the member role to lock down personal bot creation.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED,
    name: "Create shared bots",
    description: "Grants access to create workspace-owned bots that represent the workspace rather than a person.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE,
    name: "Manage bots",
    description: "Grants access to edit, archive, restore, and rotate keys for any bot in the workspace.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_READ,
    name: "Read bot runtime state",
    description: "Grants access to read bot runtime presence and invocation state.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    name: "Write bot runtime state",
    description: "Grants access to heartbeat bot runtime presence and link runtime sessions.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_READ,
    name: "Read bot invocations",
    description: "Grants access to read bot invocation state.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
    name: "Write bot invocations",
    description: "Grants access to claim, complete, or fail bot invocations.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE,
    name: "Manage members",
    description:
      "Grants access to invite members and change admin/member roles. Owner role changes still require Manage workspace owners.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN,
    name: "Administer workspace",
    description: "Grants access to workspace-wide admin surfaces such as integrations and AI budget configuration.",
  },
  {
    slug: WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER,
    name: "Manage workspace owners",
    description:
      "Grants access to ownership-only operations: promoting or demoting an owner, transferring ownership, and deleting the workspace.",
  },
])

export const WORKSPACE_ROLE_SLUGS = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const

export type WorkspaceRoleSlug = (typeof WORKSPACE_ROLE_SLUGS)[keyof typeof WORKSPACE_ROLE_SLUGS]

/**
 * Roles that can be granted via invitation. Owner promotion is an explicit
 * post-join action, never an invite role, so it's excluded here.
 */
export type WorkspaceInvitableRole = Exclude<WorkspaceRoleSlug, typeof WORKSPACE_ROLE_SLUGS.OWNER>

export interface WorkspaceRoleDefinition {
  readonly slug: WorkspaceRoleSlug
  readonly name: string
  readonly description: string
  readonly permissions: readonly WorkspacePermissionSlug[]
}

const READ_AND_SELF_SERVE: readonly WorkspacePermissionSlug[] = Object.freeze([
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH,
  WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
  WORKSPACE_PERMISSION_SCOPES.USERS_READ,
  WORKSPACE_PERMISSION_SCOPES.MEMOS_READ,
  WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
  WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE,
  WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL,
])

const ADMIN_ADDITIONS: readonly WorkspacePermissionSlug[] = Object.freeze([
  WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED,
  WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE,
  WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_READ,
  WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
  WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_READ,
  WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE,
  WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN,
])

// Role definitions are the only place where role → permission mapping lives.
// All authorization decisions derive from `permissions`, never from the role
// slug itself. Roles are a packaging artifact for display and assignment;
// permission checks are the actual gate.
export const WORKSPACE_ROLE_DEFINITIONS: readonly WorkspaceRoleDefinition[] = Object.freeze([
  {
    slug: WORKSPACE_ROLE_SLUGS.MEMBER,
    name: "Member",
    description: "Default workspace member: read access plus self-serve writes (messages, attachments, personal bots).",
    permissions: Object.freeze([...READ_AND_SELF_SERVE]),
  },
  {
    slug: WORKSPACE_ROLE_SLUGS.ADMIN,
    name: "Admin",
    description: "Manage members, bots, integrations, and workspace settings. Cannot transfer ownership.",
    permissions: Object.freeze([...READ_AND_SELF_SERVE, ...ADMIN_ADDITIONS]),
  },
  {
    slug: WORKSPACE_ROLE_SLUGS.OWNER,
    name: "Owner",
    description: "Full workspace administration including ownership transfer and workspace deletion.",
    permissions: Object.freeze([
      ...READ_AND_SELF_SERVE,
      ...ADMIN_ADDITIONS,
      WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER,
    ]),
  },
])

export const WORKSPACE_USER_ROLES = WORKSPACE_ROLE_DEFINITIONS.map((r) => r.slug) as unknown as readonly [
  WorkspaceRoleSlug,
  ...WorkspaceRoleSlug[],
]

/**
 * Roles that can be granted via invitation (everything except `owner`, which
 * is reached via post-join promotion). Declared as a non-empty tuple so it
 * works with `z.enum(...)` directly, and type-checked against
 * `WorkspaceInvitableRole` so any catalog change forces a deliberate update.
 */
export const WORKSPACE_INVITABLE_ROLES: readonly [WorkspaceInvitableRole, ...WorkspaceInvitableRole[]] = [
  WORKSPACE_ROLE_SLUGS.MEMBER,
  WORKSPACE_ROLE_SLUGS.ADMIN,
]

export function permissionsForRole(slug: WorkspaceRoleSlug): WorkspacePermissionSlug[] {
  const definition = WORKSPACE_ROLE_DEFINITIONS.find((r) => r.slug === slug)
  if (!definition) {
    throw new Error(`Unknown workspace role: ${slug}`)
  }
  return [...definition.permissions]
}

const ROLE_DISPLAY_NAMES: Record<WorkspaceRoleSlug, string> = Object.fromEntries(
  WORKSPACE_ROLE_DEFINITIONS.map((r) => [r.slug, r.name])
) as Record<WorkspaceRoleSlug, string>

/** Human-readable label for a role (e.g. "Owner", "Admin", "Member"). */
export function roleDisplayName(slug: WorkspaceRoleSlug): string {
  return ROLE_DISPLAY_NAMES[slug] ?? slug
}

/**
 * True if any of the given role slugs grants `permission`. Unknown role slugs
 * are ignored so historical WorkOS roles we don't model can't accidentally
 * grant access. Use this anywhere a check would otherwise be phrased as
 * `roleSlugs.includes("owner")` or similar — the gate is the permission, not
 * the role name.
 */
export function rolesGrant(roleSlugs: readonly string[], permission: WorkspacePermissionSlug): boolean {
  for (const slug of roleSlugs) {
    const def = WORKSPACE_ROLE_DEFINITIONS.find((r) => r.slug === slug)
    if (def?.permissions.includes(permission)) return true
  }
  return false
}

const PERMISSION_SLUG_SET = new Set<string>(Object.values(WORKSPACE_PERMISSION_SCOPES))

export function parseJwtPermissions(raw: readonly string[]): WorkspacePermissionSlug[] {
  return raw.filter((slug): slug is WorkspacePermissionSlug => PERMISSION_SLUG_SET.has(slug))
}
