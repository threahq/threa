import { WORKSPACE_USER_ROLES, resolveActiveStatus, type WorkspaceRoleSlug } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"
import { HttpError } from "../../lib/errors"

const KNOWN_ROLE_SLUGS: ReadonlySet<string> = new Set(WORKSPACE_USER_ROLES)

function assertWorkspaceRoleSlug(value: string, userId: string): asserts value is WorkspaceRoleSlug {
  if (!KNOWN_ROLE_SLUGS.has(value)) {
    throw new HttpError(`User ${userId} has unrecognized role slug "${value}"`, {
      status: 500,
      code: "UNRECOGNIZED_ROLE_SLUG",
    })
  }
}

// WorkOS membership carries one role per organization in practice
// (see `extractRoleSlugs` in workos-org-service.ts), so we pick the first
// recognized slug. Empty/unknown arrays fall back to `users.role` to keep
// the display value defined while the mirror catches up.
function pickMirroredRole(slugs: readonly string[] | null, fallback: string): string {
  if (!slugs) return fallback
  for (const slug of slugs) {
    if (KNOWN_ROLE_SLUGS.has(slug)) return slug
  }
  return fallback
}

interface UserRow {
  id: string
  workspace_id: string
  workos_user_id: string
  email: string
  role: string
  slug: string
  name: string
  description: string | null
  avatar_url: string | null
  timezone: string | null
  locale: string | null
  pronouns: string | null
  phone: string | null
  github_username: string | null
  status_emoji: string | null
  status_text: string | null
  status_expires_at: Date | null
  status_pauses_notifications: boolean
  notifications_paused_until: Date | null
  notifications_paused_indefinitely: boolean
  setup_completed: boolean
  joined_at: Date
  mirror_role_slugs: string[] | null
}

interface UserAccessRow extends Partial<UserRow> {
  workspace_exists: boolean
}

export interface User {
  id: string
  workspaceId: string
  workosUserId: string
  email: string
  role: WorkspaceRoleSlug
  slug: string
  name: string
  description: string | null
  avatarUrl: string | null
  timezone: string | null
  locale: string | null
  pronouns: string | null
  phone: string | null
  githubUsername: string | null
  statusEmoji: string | null
  statusText: string | null
  statusExpiresAt: Date | null
  statusPausesNotifications: boolean
  notificationsPausedUntil: Date | null
  notificationsPausedIndefinitely: boolean
  setupCompleted: boolean
  joinedAt: Date
}

export interface InsertUserParams {
  id: string
  workspaceId: string
  workosUserId: string
  email: string
  name: string
  role: WorkspaceRoleSlug
  slug: string
  timezone?: string | null
  locale?: string | null
  setupCompleted?: boolean
}

export interface UpdateUserParams {
  slug?: string
  name?: string
  description?: string | null
  avatarUrl?: string | null
  timezone?: string
  locale?: string
  pronouns?: string | null
  phone?: string | null
  githubUsername?: string | null
  statusEmoji?: string | null
  statusText?: string | null
  statusExpiresAt?: Date | null
  statusPausesNotifications?: boolean
  notificationsPausedUntil?: Date | null
  notificationsPausedIndefinitely?: boolean
  setupCompleted?: boolean
}

const SELECT_FIELDS = `
  id, workspace_id, workos_user_id, email, role, slug,
  name, description, avatar_url, timezone, locale,
  pronouns, phone, github_username,
  status_emoji, status_text, status_expires_at,
  status_pauses_notifications, notifications_paused_until, notifications_paused_indefinitely,
  setup_completed, joined_at
`

// Read paths derive `role` from the WorkOS authz mirror so role changes
// fanned out from the control plane reflect on next request without a
// dedicated regional write to `users.role`. `users.role` is the fallback
// for rows whose mirror entry hasn't landed yet (e.g. between invite
// acceptance and the next WorkOS event poll) or whose membership is no
// longer active. Mutation paths still write `users.role` so this fallback
// stays meaningful. `'active'` mirrors the gate in
// `WorkspaceAuthzService.resolveActivePermissions`.
const JOIN_AUTHZ_MIRROR = `
  LEFT JOIN workspace_user_permissions wup
    ON wup.workspace_id = u.workspace_id
   AND wup.workos_user_id = u.workos_user_id
   AND wup.status = 'active'
`

const USERS_WITH_PERMISSIONS_FROM = `users u ${JOIN_AUTHZ_MIRROR}`

const SELECT_FIELDS_WITH_ALIAS = `
  u.id, u.workspace_id, u.workos_user_id, u.email,
  u.role, u.slug,
  u.name, u.description, u.avatar_url, u.timezone, u.locale,
  u.pronouns, u.phone, u.github_username,
  u.status_emoji, u.status_text, u.status_expires_at,
  u.status_pauses_notifications, u.notifications_paused_until, u.notifications_paused_indefinitely,
  u.setup_completed, u.joined_at,
  wup.role_slugs AS mirror_role_slugs
`

function mapRowToUser(row: UserRow): User {
  const role = pickMirroredRole(row.mirror_role_slugs, row.role)
  assertWorkspaceRoleSlug(role, row.id)
  // Mask expired/empty statuses at the read boundary so the wire contract (and
  // every broadcast) never carries a stale status — the owner's session also
  // clears it authoritatively, but this keeps fresh reads honest regardless.
  const status = resolveActiveStatus({
    statusEmoji: row.status_emoji,
    statusText: row.status_text,
    statusExpiresAt: row.status_expires_at ? row.status_expires_at.toISOString() : null,
  })
  // Mask an elapsed manual pause at the read boundary, mirroring how the status
  // above is masked, so the wire (and every broadcast) never reports a pause
  // that has already lifted. Truthy-guard the timestamp the same way the status
  // line does, so a partial row (e.g. a narrowed test fixture) is tolerated.
  const pausedUntilActive = !!row.notifications_paused_until && row.notifications_paused_until.getTime() > Date.now()
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workosUserId: row.workos_user_id,
    email: row.email,
    role,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    locale: row.locale,
    pronouns: row.pronouns,
    phone: row.phone,
    githubUsername: row.github_username,
    statusEmoji: status?.emoji ?? null,
    statusText: status?.text ?? null,
    statusExpiresAt: status ? row.status_expires_at : null,
    // A pause flag only matters while its status is live, so drop it with the status.
    statusPausesNotifications: status ? Boolean(row.status_pauses_notifications) : false,
    notificationsPausedUntil: pausedUntilActive ? row.notifications_paused_until : null,
    notificationsPausedIndefinitely: Boolean(row.notifications_paused_indefinitely),
    setupCompleted: row.setup_completed,
    joinedAt: row.joined_at,
  }
}

export const UserRepository = {
  async findById(db: Querier, workspaceId: string, id: string): Promise<User | null> {
    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId} AND u.id = ${id}
    `)
    return result.rows[0] ? mapRowToUser(result.rows[0]) : null
  },

  async findByWorkosUserIdInWorkspace(db: Querier, workspaceId: string, workosUserId: string): Promise<User | null> {
    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId} AND u.workos_user_id = ${workosUserId}
    `)
    return result.rows[0] ? mapRowToUser(result.rows[0]) : null
  },

  async findWorkspaceUserAccess(
    db: Querier,
    workspaceId: string,
    workosUserId: string
  ): Promise<{ workspaceExists: boolean; user: User | null }> {
    const result = await db.query<UserAccessRow>(sql`
      WITH user_match AS (
        SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
        FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
        WHERE u.workspace_id = ${workspaceId} AND u.workos_user_id = ${workosUserId}
        LIMIT 1
      )
      SELECT
        EXISTS(SELECT 1 FROM workspaces WHERE id = ${workspaceId}) AS workspace_exists,
        um.id,
        um.workspace_id,
        um.workos_user_id,
        um.email,
        um.role,
        um.slug,
        um.name,
        um.description,
        um.avatar_url,
        um.timezone,
        um.locale,
        um.pronouns,
        um.phone,
        um.github_username,
        um.status_emoji,
        um.status_text,
        um.status_expires_at,
        um.status_pauses_notifications,
        um.notifications_paused_until,
        um.notifications_paused_indefinitely,
        um.setup_completed,
        um.joined_at,
        um.mirror_role_slugs
      FROM (SELECT 1) AS one
      LEFT JOIN user_match um ON true
    `)

    const row = result.rows[0]
    if (!row.workspace_exists) {
      return { workspaceExists: false, user: null }
    }

    const user = row.id ? mapRowToUser(row as UserRow) : null
    return { workspaceExists: true, user }
  },

  async findBySlug(db: Querier, workspaceId: string, slug: string): Promise<User | null> {
    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId} AND u.slug = ${slug}
    `)
    return result.rows[0] ? mapRowToUser(result.rows[0]) : null
  },

  async findBySlugs(db: Querier, workspaceId: string, slugs: string[]): Promise<User[]> {
    if (slugs.length === 0) return []

    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId} AND u.slug = ANY(${slugs})
    `)
    return result.rows.map(mapRowToUser)
  },

  async findByIds(db: Querier, workspaceId: string, ids: string[]): Promise<User[]> {
    if (ids.length === 0) return []

    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId} AND u.id = ANY(${ids})
    `)
    return result.rows.map(mapRowToUser)
  },

  async listByWorkspace(
    db: Querier,
    workspaceId: string,
    filters?: { query?: string; limit?: number; cursorJoinedAt?: Date; cursorId?: string }
  ): Promise<User[]> {
    const limit = filters?.limit ?? 200

    if (filters?.query) {
      const pattern = `%${filters.query}%`
      const result = await db.query<UserRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
        FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
        WHERE u.workspace_id = ${workspaceId}
          AND (u.name ILIKE ${pattern} OR u.email ILIKE ${pattern})
        ORDER BY u.joined_at, u.id
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToUser)
    }

    if (filters?.cursorJoinedAt && filters?.cursorId) {
      const result = await db.query<UserRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
        FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
        WHERE u.workspace_id = ${workspaceId}
          AND (u.joined_at, u.id) > (${filters.cursorJoinedAt}, ${filters.cursorId})
        ORDER BY u.joined_at, u.id
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToUser)
    }

    const result = await db.query<UserRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId}
      ORDER BY u.joined_at, u.id
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToUser)
  },

  async insert(db: Querier, params: InsertUserParams): Promise<User> {
    const result = await db.query<UserRow>(sql`
      WITH inserted AS (
        INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name, timezone, locale, setup_completed)
        VALUES (
          ${params.id},
          ${params.workspaceId},
          ${params.workosUserId},
          ${params.email},
          ${params.role},
          ${params.slug},
          ${params.name},
          ${params.timezone ?? null},
          ${params.locale ?? null},
          ${params.setupCompleted ?? true}
        )
        RETURNING ${sql.raw(SELECT_FIELDS)}
      )
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM inserted u ${sql.raw(JOIN_AUTHZ_MIRROR)}
    `)
    return mapRowToUser(result.rows[0])
  },

  async remove(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM users
      WHERE workspace_id = ${workspaceId} AND id = ${userId}
    `)
  },

  async removeByWorkosUserId(db: Querier, workspaceId: string, workosUserId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM users
      WHERE workspace_id = ${workspaceId} AND workos_user_id = ${workosUserId}
    `)
  },

  async isMember(db: Querier, workspaceId: string, workosUserId: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM users
      WHERE workspace_id = ${workspaceId} AND workos_user_id = ${workosUserId}
    `)
    return result.rows.length > 0
  },

  async findEmails(db: Querier, workspaceId: string, emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set()

    const result = await db.query<{ email: string }>(sql`
      SELECT email FROM users
      WHERE workspace_id = ${workspaceId} AND email = ANY(${emails})
    `)
    return new Set(result.rows.map((r) => r.email))
  },

  async update(db: Querier, workspaceId: string, userId: string, params: UpdateUserParams): Promise<User | null> {
    const sets: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.slug !== undefined) {
      sets.push(`slug = $${paramIndex++}`)
      values.push(params.slug)
    }
    if (params.name !== undefined) {
      sets.push(`name = $${paramIndex++}`)
      values.push(params.name)
    }
    if (params.description !== undefined) {
      sets.push(`description = $${paramIndex++}`)
      values.push(params.description)
    }
    if (params.avatarUrl !== undefined) {
      sets.push(`avatar_url = $${paramIndex++}`)
      values.push(params.avatarUrl)
    }
    if (params.timezone !== undefined) {
      sets.push(`timezone = $${paramIndex++}`)
      values.push(params.timezone)
    }
    if (params.locale !== undefined) {
      sets.push(`locale = $${paramIndex++}`)
      values.push(params.locale)
    }
    if (params.pronouns !== undefined) {
      sets.push(`pronouns = $${paramIndex++}`)
      values.push(params.pronouns)
    }
    if (params.phone !== undefined) {
      sets.push(`phone = $${paramIndex++}`)
      values.push(params.phone)
    }
    if (params.githubUsername !== undefined) {
      sets.push(`github_username = $${paramIndex++}`)
      values.push(params.githubUsername)
    }
    if (params.statusEmoji !== undefined) {
      sets.push(`status_emoji = $${paramIndex++}`)
      values.push(params.statusEmoji)
    }
    if (params.statusText !== undefined) {
      sets.push(`status_text = $${paramIndex++}`)
      values.push(params.statusText)
    }
    if (params.statusExpiresAt !== undefined) {
      sets.push(`status_expires_at = $${paramIndex++}`)
      values.push(params.statusExpiresAt)
    }
    if (params.statusPausesNotifications !== undefined) {
      sets.push(`status_pauses_notifications = $${paramIndex++}`)
      values.push(params.statusPausesNotifications)
    }
    if (params.notificationsPausedUntil !== undefined) {
      sets.push(`notifications_paused_until = $${paramIndex++}`)
      values.push(params.notificationsPausedUntil)
    }
    if (params.notificationsPausedIndefinitely !== undefined) {
      sets.push(`notifications_paused_indefinitely = $${paramIndex++}`)
      values.push(params.notificationsPausedIndefinitely)
    }
    if (params.setupCompleted !== undefined) {
      sets.push(`setup_completed = $${paramIndex++}`)
      values.push(params.setupCompleted)
    }

    if (sets.length === 0) return null

    values.push(workspaceId)
    values.push(userId)
    let whereClause = `WHERE workspace_id = $${paramIndex++} AND id = $${paramIndex}`
    if (params.setupCompleted === true) {
      whereClause += ` AND setup_completed = false`
    }

    const query = `
      WITH updated AS (
        UPDATE users SET ${sets.join(", ")}
        ${whereClause}
        RETURNING ${SELECT_FIELDS}
      )
      SELECT ${SELECT_FIELDS_WITH_ALIAS}
      FROM updated u ${JOIN_AUTHZ_MIRROR}
    `
    const result = await db.query<UserRow>(query, values)
    return result.rows[0] ? mapRowToUser(result.rows[0]) : null
  },

  async updateAvatarIfLatestUpload(
    db: Querier,
    workspaceId: string,
    userId: string,
    avatarUploadId: string,
    avatarUrl: string
  ): Promise<User | null> {
    const result = await db.query<UserRow>(sql`
      WITH updated AS (
        UPDATE users SET avatar_url = ${avatarUrl}
        WHERE workspace_id = ${workspaceId} AND id = ${userId}
          AND ${avatarUploadId} = (
            SELECT id FROM avatar_uploads
            WHERE user_id = ${userId}
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          )
        RETURNING ${sql.raw(SELECT_FIELDS)}
      )
      SELECT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)}
      FROM updated u ${sql.raw(JOIN_AUTHZ_MIRROR)}
    `)
    return result.rows[0] ? mapRowToUser(result.rows[0]) : null
  },

  async slugExistsInWorkspace(db: Querier, workspaceId: string, slug: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM users
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `)
    return result.rows.length > 0
  },

  /**
   * Search for users in a workspace by name, email, or slug.
   * Uses pg_trgm trigram similarity for fuzzy matching (handles typos),
   * combined with ILIKE for exact substring matches.
   */
  async searchByNameOrSlug(db: Querier, workspaceId: string, query: string, limit: number): Promise<User[]> {
    const pattern = `%${query}%`
    const result = await db.query<UserRow>(sql`
      SELECT DISTINCT ${sql.raw(SELECT_FIELDS_WITH_ALIAS)},
        GREATEST(
          similarity(u.name, ${query}),
          similarity(u.email, ${query}),
          similarity(u.slug, ${query})
        ) AS sim_score
      FROM ${sql.raw(USERS_WITH_PERMISSIONS_FROM)}
      WHERE u.workspace_id = ${workspaceId}
        AND (
          u.name % ${query}
          OR u.email % ${query}
          OR u.slug % ${query}
          OR u.name ILIKE ${pattern}
          OR u.email ILIKE ${pattern}
          OR u.slug ILIKE ${pattern}
        )
      ORDER BY sim_score DESC, u.name
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToUser)
  },
}
