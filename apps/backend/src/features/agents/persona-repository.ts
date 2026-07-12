import type { TonePreset, BrevityPreset, PersonaConfigPatch, PersonaCustomConfig } from "@threa/types"
import { personaConfigPatchSchema } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"
import { personaId as generatePersonaId } from "../../lib/id"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import {
  ARIADNE_AGENT_ID,
  applyBuiltInAgentPatch,
  getBuiltInAgentConfig,
  getVisibleBuiltInAgentConfig,
  listVisibleBuiltInAgentConfigs,
  type BuiltInAgentConfig,
} from "./built-in-agents"
import { stripDraftTestExcludedTools } from "./config"

/**
 * Result of resolving which persona an admin editor may write. A built-in is
 * edited additively over `base`; a custom is the workspace-owned `row`. `null`
 * (from {@link PersonaRepository.resolveEditable}) means neither — a 404.
 */
export type EditablePersona = { kind: "builtin"; base: BuiltInAgentConfig } | { kind: "custom"; row: Persona }

interface PersonaRow {
  id: string
  workspace_id: string | null
  slug: string
  name: string
  description: string | null
  avatar_emoji: string | null
  system_prompt: string | null
  model: string
  escalation_model: string | null
  temperature: number | null
  max_tokens: number | null
  enabled_tools: string[] | null
  tone_prompt: string | null
  brevity_prompt: string | null
  avatar_url: string | null
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
  /**
   * Base path of an uploaded avatar image (`avatars/{ws}/personas/{id}/{ts}`), or
   * null. Only a workspace custom can carry one (per-persona upload, roadmap 7.1
   * step 3); built-ins are always null. Resolved to a served URL by
   * `getPersonaAvatarUrl`.
   */
  avatarUrl: string | null
  systemPrompt: string | null
  model: string
  /**
   * Stronger model for per-turn escalation (roadmap 2.3); null disables
   * escalation. Built-ins carry it in code; customs in the `escalation_model`
   * column. `resolveTurnModel` is the single consumer.
   */
  escalationModel: string | null
  temperature: number | null
  maxTokens: number | null
  enabledTools: string[] | null
  /**
   * Style slots (roadmap 7.1). A built-in persona carries preset keys
   * (`tonePreset`/`brevityPreset`); a custom persona carries the free-text
   * `tonePrompt`/`brevityPrompt` instead. The two shapes are mutually exclusive
   * — a built-in's text slots are null, a custom's presets are null.
   * `resolvePersonaStyleSlots` (companion/config.ts) collapses whichever is set
   * into the assembled `## Response Style` section.
   */
  tonePreset: TonePreset | null
  brevityPreset: BrevityPreset | null
  tonePrompt: string | null
  brevityPrompt: string | null
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
    avatarUrl: row.avatar_url,
    systemPrompt: row.system_prompt,
    model: row.model,
    escalationModel: row.escalation_model,
    temperature: row.temperature === null ? null : Number(row.temperature),
    maxTokens: row.max_tokens,
    enabledTools: row.enabled_tools,
    // Custom personas never carry preset keys — only free-text slots.
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: row.tone_prompt,
    brevityPrompt: row.brevity_prompt,
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
    avatarUrl: agent.avatarUrl,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    escalationModel: agent.escalationModel,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    enabledTools: agent.enabledTools,
    tonePreset: agent.tonePreset,
    brevityPreset: agent.brevityPreset,
    tonePrompt: agent.tonePrompt,
    brevityPrompt: agent.brevityPrompt,
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

/**
 * Resolve the persona a `draft_test` turn should run: the built-in base merged
 * with the editor's unsaved draft patch (NOT the stored override), with
 * durable-write tools stripped for test safety (roadmap 7.1). Pure — no DB read;
 * the caller supplies the loaded draft row.
 *
 * Returns `null` to signal the turn must fall back to normal resolution: the
 * draft row is gone (committed/discarded mid-chat), belongs to another
 * workspace/agent, or the id is not an editable visible built-in. Callers must
 * treat `null` as "continue as catch_up", never as an error (INV-11 fail-loud
 * would wrongly abort a live test chat here).
 */
export function resolveDraftTestPersona(
  draft: { workspaceId: string; agentId: string; patch: unknown } | null,
  personaId: string,
  workspaceId: string,
  customBase: Persona | null = null
): Persona | null {
  if (!draft || draft.workspaceId !== workspaceId || draft.agentId !== personaId) return null

  const base = getVisibleBuiltInAgentConfig(personaId)
  if (base) {
    let resolved: BuiltInAgentConfig
    try {
      resolved = applyBuiltInAgentPatch(base, draft.patch, { workspaceId, agentId: personaId })
    } catch {
      // A corrupt stored patch must degrade to the saved config, not abort the
      // live turn — the null contract above is total, not just for gone rows.
      return null
    }
    const persona = mapBuiltInToPersona(resolved)
    return { ...persona, enabledTools: stripDraftTestExcludedTools(persona.enabledTools) }
  }

  // Custom persona: apply the sparse draft over the saved row (same total-null
  // contract — a gone/foreign/corrupt draft or a wrong-workspace row falls back
  // to normal resolution). Presets never apply to a custom, so they are dropped.
  if (!customBase || customBase.managedBy !== "workspace" || customBase.workspaceId !== workspaceId) return null
  let parsed: PersonaConfigPatch
  try {
    parsed = personaConfigPatchSchema.parse(draft.patch)
  } catch {
    return null
  }
  const { tonePreset: _tonePreset, brevityPreset: _brevityPreset, ...customFields } = parsed
  const merged: Persona = { ...customBase, ...customFields }
  return { ...merged, enabledTools: stripDraftTestExcludedTools(merged.enabledTools) }
}

const SELECT_FIELDS = `
  id, workspace_id, slug, name, description, avatar_emoji,
  system_prompt, model, escalation_model, temperature, max_tokens, enabled_tools,
  tone_prompt, brevity_prompt, avatar_url,
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

  /**
   * A workspace-owned custom persona by id, any status (active/archived), or
   * null. Hard-scoped to `managed_by = 'workspace'` AND the caller workspace
   * (INV-8) so a custom write/read path can never touch a system row or another
   * workspace's persona. Archived customs resolve here (for history/actor
   * rendering) but are excluded from {@link listActiveCustoms}.
   */
  async findWorkspacePersona(db: Querier, workspaceId: string, personaId: string): Promise<Persona | null> {
    const result = await db.query<PersonaRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM personas
      WHERE id = ${personaId}
        AND workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
    `)
    return result.rows[0] ? mapRowToPersona(result.rows[0]) : null
  },

  /** Active custom personas for a workspace, alphabetical — the roster's custom tail. */
  async listActiveCustoms(db: Querier, workspaceId: string): Promise<Persona[]> {
    const result = await db.query<PersonaRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM personas
      WHERE workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
        AND status = 'active'
      ORDER BY name ASC
    `)
    return result.rows.map(mapRowToPersona)
  },

  /** Archived custom personas — the roster's Archived disclosure (unarchive targets). */
  async listArchivedCustoms(db: Querier, workspaceId: string): Promise<Persona[]> {
    const result = await db.query<PersonaRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM personas
      WHERE workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
        AND status = 'archived'
      ORDER BY name ASC
    `)
    return result.rows.map(mapRowToPersona)
  },

  /**
   * Resolve which persona an admin editor may write: a code-backed visible
   * built-in (edited additively) or a workspace-owned custom row (any status).
   * `null` = neither (a 404). The single gate that replaces the per-endpoint
   * `getVisibleBuiltInAgentConfig` checks (roadmap 7.1 step 2). Built-in ids
   * short-circuit with no DB read.
   */
  async resolveEditable(db: Querier, workspaceId: string, personaId: string): Promise<EditablePersona | null> {
    const base = getVisibleBuiltInAgentConfig(personaId)
    if (base) return { kind: "builtin", base }
    const row = await this.findWorkspacePersona(db, workspaceId, personaId)
    return row ? { kind: "custom", row } : null
  },

  /**
   * Insert a new custom persona row (a fork). The caller supplies a
   * workspace-scoped `slug`; a collision with the `(workspace_id, slug)` unique
   * constraint surfaces as a raw 23505 for the caller to retry with a suffix
   * (race-safe, INV-20). Always `managed_by = 'workspace'`, `status = 'active'`.
   */
  async insertWorkspacePersona(
    db: Querier,
    params: { workspaceId: string; slug: string; config: PersonaCustomConfig }
  ): Promise<Persona> {
    const { workspaceId, slug, config } = params
    const result = await db.query<PersonaRow>(sql`
      INSERT INTO personas (
        id, workspace_id, slug, name, description, avatar_emoji,
        system_prompt, model, escalation_model, temperature, max_tokens, enabled_tools,
        tone_prompt, brevity_prompt, managed_by, status
      ) VALUES (
        ${generatePersonaId()}, ${workspaceId}, ${slug}, ${config.name}, ${config.description}, ${config.avatarEmoji},
        ${config.systemPrompt}, ${config.model}, ${config.escalationModel}, ${config.temperature}, ${config.maxTokens}, ${config.enabledTools}::text[],
        ${config.tonePrompt}, ${config.brevityPrompt}, 'workspace', 'active'
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToPersona(result.rows[0]!)
  },

  /**
   * Full-field update of a custom persona with optimistic concurrency. MUST run
   * in a transaction: a `FOR UPDATE` lock on the scoped row serializes concurrent
   * admins (INV-20), and `expectedUpdatedAt` must equal the row's `updated_at` or
   * the write is a `conflict`. Hard-scoped to `managed_by = 'workspace'` AND the
   * caller workspace (INV-8) — never touches a system row. `slug` is immutable and
   * not written; `updated_at` is bumped by the table trigger.
   */
  async updateWorkspacePersona(
    db: Querier,
    params: { workspaceId: string; personaId: string; expectedUpdatedAt: string | null; config: PersonaCustomConfig }
  ): Promise<UpdateWorkspacePersonaResult> {
    const { workspaceId, personaId, expectedUpdatedAt, config } = params

    const existing = await db.query<PersonaRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM personas
      WHERE id = ${personaId}
        AND workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
      FOR UPDATE
    `)
    const current = existing.rows[0]
    if (!current) return { outcome: "conflict", current: null }

    const currentUpdatedAt = current.updated_at.toISOString()
    if (expectedUpdatedAt !== currentUpdatedAt) {
      return { outcome: "conflict", current: mapRowToPersona(current) }
    }

    const updated = await db.query<PersonaRow>(sql`
      UPDATE personas SET
        name = ${config.name},
        description = ${config.description},
        avatar_emoji = ${config.avatarEmoji},
        system_prompt = ${config.systemPrompt},
        model = ${config.model},
        escalation_model = ${config.escalationModel},
        temperature = ${config.temperature},
        max_tokens = ${config.maxTokens},
        enabled_tools = ${config.enabledTools}::text[],
        tone_prompt = ${config.tonePrompt},
        brevity_prompt = ${config.brevityPrompt}
      WHERE id = ${personaId}
        AND workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    const row = updated.rows[0]!
    return { outcome: "written", row: mapRowToPersona(row), updatedAt: row.updated_at.toISOString() }
  },

  /**
   * Flip a custom persona's status (archive/unarchive). Hard-scoped to
   * `managed_by = 'workspace'` AND the caller workspace (INV-8). Returns the
   * updated row, or null when no such custom exists (a 404).
   */
  async setStatus(
    db: Querier,
    params: { workspaceId: string; personaId: string; status: "active" | "archived" }
  ): Promise<Persona | null> {
    const { workspaceId, personaId, status } = params
    const result = await db.query<PersonaRow>(sql`
      UPDATE personas SET status = ${status}
      WHERE id = ${personaId}
        AND workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToPersona(result.rows[0]) : null
  },

  /**
   * Set (or clear, with `null`) a custom persona's avatar base path. Hard-scoped
   * to `managed_by = 'workspace'` AND the caller workspace (INV-8) so the avatar
   * write path can never touch a system row. Returns the updated row, or null
   * when no such custom exists (a 404). `updated_at` is bumped by the table
   * trigger.
   */
  async updateAvatarUrl(
    db: Querier,
    params: { workspaceId: string; personaId: string; avatarUrl: string | null }
  ): Promise<Persona | null> {
    const { workspaceId, personaId, avatarUrl } = params
    const result = await db.query<PersonaRow>(sql`
      UPDATE personas SET avatar_url = ${avatarUrl}
      WHERE id = ${personaId}
        AND workspace_id = ${workspaceId}
        AND managed_by = 'workspace'
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRowToPersona(result.rows[0]) : null
  },
}

export type UpdateWorkspacePersonaResult =
  | { outcome: "written"; row: Persona; updatedAt: string }
  | { outcome: "conflict"; current: Persona | null }
