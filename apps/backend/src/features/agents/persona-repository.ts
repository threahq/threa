import type { Querier } from "../../db"
import { sql } from "../../db"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import {
  ARIADNE_AGENT_ID,
  applyBuiltInAgentPatch,
  getBuiltInAgentConfig,
  listVisibleBuiltInAgentConfigs,
  type BuiltInAgentConfig,
} from "./built-in-agents"

interface PersonaRow {
  id: string
  workspace_id: string | null
  slug: string
  name: string
  description: string | null
  avatar_emoji: string | null
  system_prompt: string | null
  model: string
  temperature: number | null
  max_tokens: number | null
  enabled_tools: string[] | null
  managed_by: string
  status: string
  created_at: Date
  updated_at: Date
}

export interface Persona {
  id: string
  workspaceId: string | null
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  systemPrompt: string | null
  model: string
  /**
   * Stronger model for per-turn escalation (roadmap 2.3). Built-in personas
   * only for now — DB personas have no column and resolve to null (escalation
   * disabled); `resolveTurnModel` is the single consumer, so a column slots in
   * without touching call sites when workspace personas need it.
   */
  escalationModel: string | null
  temperature: number | null
  maxTokens: number | null
  enabledTools: string[] | null
  managedBy: "system" | "workspace"
  status: "active" | "disabled" | "archived"
  createdAt: Date
  updatedAt: Date
}

function mapRowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarEmoji: row.avatar_emoji,
    systemPrompt: row.system_prompt,
    model: row.model,
    escalationModel: null,
    temperature: row.temperature === null ? null : Number(row.temperature),
    maxTokens: row.max_tokens,
    enabledTools: row.enabled_tools,
    managedBy: row.managed_by as "system" | "workspace",
    status: row.status as "active" | "disabled" | "archived",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const BUILT_IN_AGENT_CONFIG_TIMESTAMP = new Date("2026-04-25T00:00:00.000Z")

// Do not return a nested `sql`...`` fragment from a helper and embed it in another
// `sql` template: squid 0.5 flattens placeholders incorrectly (sub-fragment object in
// `values`), which yields invalid SQL ("syntax error at or near $2"). Inline the
// optional workspace filter in each query (INV-8: scoped reads see only the caller
// workspace or global system rows).

function mapBuiltInToPersona(agent: BuiltInAgentConfig): Persona {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    avatarEmoji: agent.avatarEmoji,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    escalationModel: agent.escalationModel,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    enabledTools: agent.enabledTools,
    managedBy: agent.managedBy,
    status: agent.status,
    createdAt: BUILT_IN_AGENT_CONFIG_TIMESTAMP,
    updatedAt: BUILT_IN_AGENT_CONFIG_TIMESTAMP,
  }
}

async function resolveBuiltInPersona(
  db: Querier,
  agentId: string,
  workspaceId?: string | null
): Promise<Persona | null> {
  const base = getBuiltInAgentConfig(agentId)
  if (!base) return null

  if (!workspaceId) return mapBuiltInToPersona(base)

  const override = await AgentConfigOverrideRepository.findActiveByWorkspaceAndAgent(db, workspaceId, agentId)
  const resolved = override ? applyBuiltInAgentPatch(base, override.patch, { workspaceId, agentId }) : base
  return mapBuiltInToPersona(resolved)
}

function resolveBuiltInPersonaWithOverrides(
  base: BuiltInAgentConfig,
  overridesByAgentId: Map<string, unknown>,
  workspaceId: string
): Persona {
  const patch = overridesByAgentId.get(base.id)
  const resolved = patch ? applyBuiltInAgentPatch(base, patch, { workspaceId, agentId: base.id }) : base
  return mapBuiltInToPersona(resolved)
}

const SELECT_FIELDS = `
  id, workspace_id, slug, name, description, avatar_emoji,
  system_prompt, model, temperature, max_tokens, enabled_tools,
  managed_by, status, created_at, updated_at
`

export const PersonaRepository = {
  async findById(db: Querier, id: string, workspaceId?: string | null): Promise<Persona | null> {
    const builtIn = await resolveBuiltInPersona(db, id, workspaceId)
    if (builtIn) return builtIn

    const result = await db.query<PersonaRow>(
      workspaceId == null
        ? sql`
            SELECT ${sql.raw(SELECT_FIELDS)}
            FROM personas
            WHERE id = ${id}
          `
        : sql`
            SELECT ${sql.raw(SELECT_FIELDS)}
            FROM personas
            WHERE id = ${id}
              AND (workspace_id = ${workspaceId} OR workspace_id IS NULL)
          `
    )
    return result.rows[0] ? mapRowToPersona(result.rows[0]) : null
  },

  async findByIds(db: Querier, ids: string[], workspaceId?: string | null): Promise<Persona[]> {
    if (ids.length === 0) return []

    const builtInConfigs = ids.map(getBuiltInAgentConfig).filter((agent): agent is BuiltInAgentConfig => agent !== null)
    const dbIds = ids.filter((id) => !getBuiltInAgentConfig(id))
    let builtIns: Persona[]

    if (workspaceId && builtInConfigs.length > 0) {
      const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(db, workspaceId)
      const overridesByAgentId = new Map(overrides.map((override) => [override.agentId, override.patch]))
      builtIns = builtInConfigs.map((agent) =>
        resolveBuiltInPersonaWithOverrides(agent, overridesByAgentId, workspaceId)
      )
    } else {
      builtIns = builtInConfigs.map(mapBuiltInToPersona)
    }

    if (dbIds.length === 0) return builtIns

    const result = await db.query<PersonaRow>(
      workspaceId == null
        ? sql`
            SELECT ${sql.raw(SELECT_FIELDS)}
            FROM personas
            WHERE id = ANY(${dbIds})
          `
        : sql`
            SELECT ${sql.raw(SELECT_FIELDS)}
            FROM personas
            WHERE id = ANY(${dbIds})
              AND (workspace_id = ${workspaceId} OR workspace_id IS NULL)
          `
    )
    return [...builtIns, ...result.rows.map(mapRowToPersona)]
  },

  async findBySlug(db: Querier, slug: string, workspaceId?: string | null): Promise<Persona | null> {
    const builtInBySlug = listVisibleBuiltInAgentConfigs().find((agent) => agent.slug === slug)

    // System personas have null workspace_id
    if (workspaceId === null || workspaceId === undefined) {
      if (builtInBySlug) {
        return resolveBuiltInPersona(db, builtInBySlug.id)
      }

      const result = await db.query<PersonaRow>(
        sql`
          SELECT ${sql.raw(SELECT_FIELDS)}
          FROM personas
          WHERE slug = ${slug} AND workspace_id IS NULL
        `
      )
      return result.rows[0] ? mapRowToPersona(result.rows[0]) : null
    }

    // Look for workspace-specific first, fall back to system
    const workspaceResult = await db.query<PersonaRow>(
      sql`
        SELECT ${sql.raw(SELECT_FIELDS)}
        FROM personas
        WHERE slug = ${slug} AND workspace_id = ${workspaceId}
          AND status = 'active'
        LIMIT 1
      `
    )
    if (workspaceResult.rows[0]) return mapRowToPersona(workspaceResult.rows[0])

    if (builtInBySlug) {
      return resolveBuiltInPersona(db, builtInBySlug.id, workspaceId)
    }

    const systemResult = await db.query<PersonaRow>(
      sql`
        SELECT ${sql.raw(SELECT_FIELDS)}
        FROM personas
        WHERE slug = ${slug} AND workspace_id IS NULL
          AND status = 'active'
        LIMIT 1
      `
    )
    return systemResult.rows[0] ? mapRowToPersona(systemResult.rows[0]) : null
  },

  /**
   * Batched slug lookup (INV-56) used by the mention resolver. Returns at most
   * one active persona per requested slug, applying the same precedence as
   * `findBySlug`: a workspace-specific active persona wins over a built-in,
   * which wins over a system (`workspace_id IS NULL`) row. Slugs are matched
   * case-insensitively.
   */
  async findBySlugs(db: Querier, slugs: string[], workspaceId?: string | null): Promise<Persona[]> {
    if (slugs.length === 0) return []

    const lowered = slugs.map((slug) => slug.toLowerCase())
    const want = new Set(lowered)
    const bySlug = new Map<string, Persona>()
    const resolvedPrecedence = new Map<string, number>()

    const consider = (persona: Persona, precedence: number): void => {
      const key = persona.slug.toLowerCase()
      if (!want.has(key)) return
      const existing = resolvedPrecedence.get(key)
      if (existing === undefined || precedence < existing) {
        bySlug.set(key, persona)
        resolvedPrecedence.set(key, precedence)
      }
    }

    if (workspaceId === null || workspaceId === undefined) {
      const builtIns = listVisibleBuiltInAgentConfigs().map(mapBuiltInToPersona)
      for (const persona of builtIns) consider(persona, 1)

      const result = await db.query<PersonaRow>(
        sql`
          SELECT ${sql.raw(SELECT_FIELDS)}
          FROM personas
          WHERE LOWER(slug) = ANY(${lowered}) AND workspace_id IS NULL
        `
      )
      for (const row of result.rows) consider(mapRowToPersona(row), 2)
      return [...bySlug.values()]
    }

    const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(db, workspaceId)
    const overridesByAgentId = new Map(overrides.map((override) => [override.agentId, override.patch]))
    const builtIns = listVisibleBuiltInAgentConfigs()
      .map((agent) => resolveBuiltInPersonaWithOverrides(agent, overridesByAgentId, workspaceId))
      .filter((persona) => persona.status === "active")
    for (const persona of builtIns) consider(persona, 1)

    const result = await db.query<PersonaRow>(
      sql`
        SELECT ${sql.raw(SELECT_FIELDS)}
        FROM personas
        WHERE LOWER(slug) = ANY(${lowered})
          AND (workspace_id = ${workspaceId} OR workspace_id IS NULL)
          AND status = 'active'
      `
    )
    for (const row of result.rows) {
      // Workspace-specific rows beat built-in/system; system rows are the fallback.
      consider(mapRowToPersona(row), row.workspace_id === null ? 2 : 0)
    }
    return [...bySlug.values()]
  },

  /**
   * Get the default system persona (Ariadne).
   */
  async getSystemDefault(db: Querier, workspaceId?: string | null): Promise<Persona | null> {
    const persona = await resolveBuiltInPersona(db, ARIADNE_AGENT_ID, workspaceId)
    return persona?.status === "active" ? persona : null
  },

  /**
   * List all personas available to a workspace (system + workspace-specific).
   */
  async listForWorkspace(db: Querier, workspaceId: string): Promise<Persona[]> {
    const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(db, workspaceId)
    const overridesByAgentId = new Map(overrides.map((override) => [override.agentId, override.patch]))
    const builtIns = listVisibleBuiltInAgentConfigs()
      .map((agent) => resolveBuiltInPersonaWithOverrides(agent, overridesByAgentId, workspaceId))
      .filter((persona) => persona.status === "active")

    const result = await db.query<PersonaRow>(
      sql`
        SELECT ${sql.raw(SELECT_FIELDS)}
        FROM personas
        WHERE workspace_id = ${workspaceId}
          AND status = 'active'
        ORDER BY managed_by ASC, name ASC
      `
    )
    return [...builtIns, ...result.rows.map(mapRowToPersona)]
  },
}
