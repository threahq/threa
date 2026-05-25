import { BOT_TRAITS, BOT_TYPES, BotTypes, type BotTrait, type BotType } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

interface BotRow {
  id: string
  workspace_id: string
  api_key_id: string | null
  type: string
  owner_user_id: string | null
  traits: string[]
  slug: string | null
  name: string
  description: string | null
  avatar_emoji: string | null
  avatar_url: string | null
  archived_at: Date | null
  created_at: Date
  updated_at: Date
}

interface BotBase {
  id: string
  workspaceId: string
  apiKeyId: string | null
  traits: BotTrait[]
  slug: string | null
  name: string
  description: string | null
  avatarEmoji: string | null
  avatarUrl: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Discriminated on `type`. The shape invariant
 * `(type='personal') ⇔ (ownerUserId !== null)` is enforced at every read
 * (`mapRowToBot`) and write (`create`), so callers can narrow on `type`
 * and rely on `ownerUserId` being non-null in the personal arm.
 */
export type Bot =
  | (BotBase & { type: "shared"; ownerUserId: null })
  | (BotBase & { type: "personal"; ownerUserId: string })

const BOT_COLUMNS =
  "id, workspace_id, api_key_id, type, owner_user_id, traits, slug, name, description, avatar_emoji, avatar_url, archived_at, created_at, updated_at"

const KNOWN_BOT_TYPES = new Set<string>(BOT_TYPES)
const KNOWN_BOT_TRAITS = new Set<string>(BOT_TRAITS)

function mapRowToBot(row: BotRow): Bot {
  if (!KNOWN_BOT_TYPES.has(row.type)) {
    throw new Error(`Bot ${row.id} has unknown type "${row.type}"`)
  }
  for (const trait of row.traits) {
    if (!KNOWN_BOT_TRAITS.has(trait)) {
      throw new Error(`Bot ${row.id} has unknown trait "${trait}"`)
    }
  }
  const base: BotBase = {
    id: row.id,
    workspaceId: row.workspace_id,
    apiKeyId: row.api_key_id,
    traits: row.traits as BotTrait[],
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarEmoji: row.avatar_emoji,
    avatarUrl: row.avatar_url,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  // Shape invariant (INV-11): personal bots have an owner; shared bots do not.
  // A row violating this means a writer bypassed the repo contract — fail loudly.
  if (row.type === BotTypes.PERSONAL) {
    if (row.owner_user_id === null) {
      throw new Error(`Bot ${row.id} is personal but has no owner_user_id`)
    }
    return { ...base, type: "personal", ownerUserId: row.owner_user_id }
  }
  if (row.owner_user_id !== null) {
    throw new Error(`Bot ${row.id} is shared but has owner_user_id=${row.owner_user_id}`)
  }
  return { ...base, type: "shared", ownerUserId: null }
}

export const BotRepository = {
  async findByApiKeyId(db: Querier, workspaceId: string, apiKeyId: string): Promise<Bot | null> {
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId} AND api_key_id = ${apiKeyId}
    `)
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<Bot | null> {
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },

  async findByIds(db: Querier, workspaceId: string, ids: string[]): Promise<Bot[]> {
    if (ids.length === 0) return []
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids})
    `)
    return result.rows.map(mapRowToBot)
  },

  async listByWorkspace(db: Querier, workspaceId: string, options: { type?: BotType } = {}): Promise<Bot[]> {
    const typeFilter = options.type ?? null
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToBot)
  },

  /**
   * Bots the given user can see in their bootstrap: all shared bots in the workspace
   * plus the user's own personal bots. Personal bots owned by other users are excluded.
   */
  async listVisibleTo(db: Querier, workspaceId: string, userId: string): Promise<Bot[]> {
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND (type = ${BotTypes.SHARED} OR (type = ${BotTypes.PERSONAL} AND owner_user_id = ${userId}))
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToBot)
  },

  async findBySlugs(db: Querier, workspaceId: string, slugs: string[]): Promise<Bot[]> {
    if (slugs.length === 0) return []

    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId} AND slug = ANY(${slugs}) AND archived_at IS NULL
    `)
    return result.rows.map(mapRowToBot)
  },

  async findVisibleBySlugs(db: Querier, workspaceId: string, userId: string, slugs: string[]): Promise<Bot[]> {
    if (slugs.length === 0) return []

    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId}
        AND slug = ANY(${slugs})
        AND archived_at IS NULL
        AND (type = ${BotTypes.SHARED} OR (type = ${BotTypes.PERSONAL} AND owner_user_id = ${userId}))
    `)
    return result.rows.map(mapRowToBot)
  },

  async create(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      type: BotType
      ownerUserId: string | null
      traits?: BotTrait[]
      slug: string
      name: string
      description?: string | null
      avatarEmoji?: string | null
    }
  ): Promise<Bot> {
    // Validate against the canonical type/trait vocabularies up front so an
    // unknown value never reaches the INSERT (and never round-trips back via
    // RETURNING with a row mapRowToBot would later reject).
    if (!KNOWN_BOT_TYPES.has(params.type)) {
      throw new Error(`Bot create: unknown type "${params.type}"`)
    }
    // Enforce the type/owner shape invariant at the write boundary so the
    // database never holds an inconsistent row (INV-20 — race-safe writes
    // start with a correct contract).
    const isPersonal = params.type === "personal"
    if (isPersonal !== (params.ownerUserId !== null)) {
      throw new Error(`Bot create: type=${params.type} requires ownerUserId=${isPersonal ? "non-null" : "null"}`)
    }
    const traits = params.traits ?? []
    for (const trait of traits) {
      if (!KNOWN_BOT_TRAITS.has(trait)) {
        throw new Error(`Bot create: unknown trait "${trait}"`)
      }
    }
    const result = await db.query<BotRow>(sql`
      INSERT INTO bots (id, workspace_id, type, owner_user_id, traits, slug, name, description, avatar_emoji)
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.type},
        ${params.ownerUserId},
        ${traits},
        ${params.slug},
        ${params.name},
        ${params.description ?? null},
        ${params.avatarEmoji ?? null}
      )
      RETURNING ${sql.raw(BOT_COLUMNS)}
    `)
    return mapRowToBot(result.rows[0])
  },

  async listByOwner(
    db: Querier,
    workspaceId: string,
    ownerUserId: string,
    options: { traits?: BotTrait[] } = {}
  ): Promise<Bot[]> {
    const traitsFilter = options.traits ?? []
    const result = await db.query<BotRow>(sql`
      SELECT ${sql.raw(BOT_COLUMNS)}
      FROM bots
      WHERE workspace_id = ${workspaceId}
        AND owner_user_id = ${ownerUserId}
        AND archived_at IS NULL
        AND (${traitsFilter}::text[] = '{}' OR traits @> ${traitsFilter}::text[])
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToBot)
  },

  async update(
    db: Querier,
    id: string,
    workspaceId: string,
    fields: {
      slug?: string
      name?: string
      description?: string | null
      avatarEmoji?: string | null
      traits?: BotTrait[]
    }
  ): Promise<Bot | null> {
    if (
      fields.slug === undefined &&
      fields.name === undefined &&
      fields.description === undefined &&
      fields.avatarEmoji === undefined &&
      fields.traits === undefined
    ) {
      const result = await db.query<BotRow>(sql`
        SELECT ${sql.raw(BOT_COLUMNS)}
        FROM bots
        WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      `)
      if (!result.rows[0]) return null
      return mapRowToBot(result.rows[0])
    }

    if (fields.traits !== undefined) {
      for (const trait of fields.traits) {
        if (!KNOWN_BOT_TRAITS.has(trait)) {
          throw new Error(`Bot update: unknown trait "${trait}"`)
        }
      }
    }

    // Dynamic SET with parameterized values. Column names are hardcoded constants;
    // only user-provided values go through parameter binding ($N).
    const setParts: string[] = []
    const values: unknown[] = []
    let idx = 1
    if (fields.slug !== undefined) {
      setParts.push(`slug = $${idx++}`)
      values.push(fields.slug)
    }
    if (fields.name !== undefined) {
      setParts.push(`name = $${idx++}`)
      values.push(fields.name)
    }
    if (fields.description !== undefined) {
      setParts.push(`description = $${idx++}`)
      values.push(fields.description)
    }
    if (fields.avatarEmoji !== undefined) {
      setParts.push(`avatar_emoji = $${idx++}`)
      values.push(fields.avatarEmoji)
    }
    if (fields.traits !== undefined) {
      setParts.push(`traits = $${idx++}`)
      values.push(fields.traits)
    }
    setParts.push("updated_at = NOW()")
    const idIdx = idx++
    const wsIdx = idx
    values.push(id, workspaceId)

    const result = await db.query<BotRow>({
      text: `UPDATE bots SET ${setParts.join(", ")} WHERE id = $${idIdx} AND workspace_id = $${wsIdx} AND archived_at IS NULL RETURNING ${BOT_COLUMNS}`,
      values,
    })
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },

  async addTraitsIfMissing(
    db: Querier,
    id: string,
    workspaceId: string,
    traits: readonly BotTrait[]
  ): Promise<Bot | null> {
    if (traits.length === 0) return null
    for (const trait of traits) {
      if (!KNOWN_BOT_TRAITS.has(trait)) {
        throw new Error(`Bot addTraitsIfMissing: unknown trait "${trait}"`)
      }
    }
    const result = await db.query<BotRow>(sql`
      UPDATE bots
      SET traits = ARRAY(SELECT DISTINCT trait FROM unnest(traits || ${traits}::text[]) AS trait ORDER BY trait),
          updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND NOT (traits @> ${traits}::text[])
      RETURNING ${sql.raw(BOT_COLUMNS)}
    `)
    return result.rows[0] ? mapRowToBot(result.rows[0]) : null
  },

  async updateAvatarUrl(db: Querier, id: string, workspaceId: string, avatarUrl: string | null): Promise<Bot | null> {
    const result = await db.query<BotRow>(sql`
      UPDATE bots
      SET avatar_url = ${avatarUrl}, updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      RETURNING ${sql.raw(BOT_COLUMNS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },

  async archive(db: Querier, id: string, workspaceId: string): Promise<Bot | null> {
    const result = await db.query<BotRow>(sql`
      UPDATE bots
      SET archived_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      RETURNING ${sql.raw(BOT_COLUMNS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },

  async restore(db: Querier, id: string, workspaceId: string): Promise<Bot | null> {
    const result = await db.query<BotRow>(sql`
      UPDATE bots
      SET archived_at = NULL, updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NOT NULL
      RETURNING ${sql.raw(BOT_COLUMNS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToBot(result.rows[0])
  },
}
