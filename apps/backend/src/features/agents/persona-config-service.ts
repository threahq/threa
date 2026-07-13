import type { Pool } from "pg"
import { generateSlug } from "@threa/backend-common"
import type { ModelRegistry } from "@threa/agent-runtime"
import {
  personaConfigPatchSchema,
  personaCustomConfigSchema,
  SYSTEM_PERSONA_EDITABLE_FIELDS,
  type SystemPersonaEditableField,
  AuthorTypes,
  CompanionModes,
  MemoryModes,
  StreamPurposes,
  type PersonaConfigPatch,
  type PersonaConfigResponse,
  type PersonaConfigRevision,
  type PersonaCustomConfig,
  type PersonaDraftState,
  type PersonaListItem,
  type PersonaModelOption,
  type PersonaResolvedConfig,
} from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import type { StreamService } from "../streams"
import { AgentConfigOverrideRepository, type AgentConfigOverrideDetail } from "./agent-config-override-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"
import { PersonaRepository, type EditablePersona, type Persona } from "./persona-repository"
import { COMPANION_MODEL_ID, resolvePersonaStyleSlots } from "./companion/config"
import {
  applyBuiltInAgentPatch,
  builtInAgentConfigPatchSchema,
  getVisibleBuiltInAgentConfig,
  listVisibleBuiltInAgentConfigs,
  type BuiltInAgentConfig,
} from "./built-in-agents"

interface Dependencies {
  pool: Pool
  streamService: StreamService
  modelRegistry: ModelRegistry
}

/**
 * The authenticated caller acting on a persona. `isAdmin` is workspace-admin,
 * resolved in the handler from the same JWT-permission/role fallback the route
 * middleware used (user-scoped-personas). Built-in and workspace personas need
 * `isAdmin`; a personal persona needs only ownership (enforced by resolving with
 * `userId` as the viewer), so a non-owner — admin included — never sees it.
 */
export interface PersonaCaller {
  userId: string
  isAdmin: boolean
}

/** Cap on the revision history list; older revisions are omitted (and logged) past this. */
const REVISION_LIST_LIMIT = 50

export type SetPersonaOverrideResult =
  // `updatedAt` is null when the write left no override row — a reset-to-default
  // (empty patch), which returns the persona to its built-in config.
  | { outcome: "written"; persona: PersonaListItem; updatedAt: string | null }
  | { outcome: "conflict"; current: AgentConfigOverrideDetail | null }

/** Result of a custom-persona write (fork excluded — a fork always succeeds or throws). */
export type UpdateCustomPersonaResult =
  | { outcome: "written"; persona: PersonaListItem; updatedAt: string }
  // The current row's resolved config + OCC token, so the editor can re-sync on a 409.
  | { outcome: "conflict"; current: { config: PersonaResolvedConfig; updatedAt: string } | null }

/** Cap on fork slug-collision retries before giving up (a wildly popular base name). */
const MAX_FORK_SLUG_ATTEMPTS = 50

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505"
}

function personaNotFound(): HttpError {
  return new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })
}

/**
 * Non-admin acting on a built-in or workspace persona. Matches
 * `requireWorkspacePermission`'s error shape (403 FORBIDDEN) so opening the
 * routes to plain `authed` keeps API behavior equivalent for non-admins. A
 * non-owner acting on a PERSONAL persona gets 404 instead (invisible means
 * invisible) — that path never reaches here because the row won't resolve.
 */
function forbidden(): HttpError {
  return new HttpError("Insufficient permissions", { status: 403, code: "FORBIDDEN" })
}

function customsOnly(): HttpError {
  return new HttpError("This action is only available for custom personas", {
    status: 400,
    code: "PERSONA_NOT_CUSTOM",
  })
}

/** Map a custom persona row to the resolved-config wire shape (the editor's populated form). */
function customRowToResolvedConfig(row: Persona): PersonaResolvedConfig {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarEmoji: row.avatarEmoji,
    avatarUrl: row.avatarUrl,
    systemPrompt: row.systemPrompt ?? "",
    model: row.model,
    escalationModel: row.escalationModel,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    enabledTools: (row.enabledTools ?? []) as PersonaResolvedConfig["enabledTools"],
    // Customs carry free-text slots, never preset keys.
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: row.tonePrompt,
    brevityPrompt: row.brevityPrompt,
    // A personal row resolves as `managed_by = 'user'`; a workspace custom as
    // `workspace` (user-scoped-personas). The editor branches on the response's
    // `kind`, not this, but it must round-trip the true value.
    managedBy: row.managedBy,
    status: row.status,
    visibility: "visible",
    e2eCapable: false,
  }
}

/** The full editable config of a custom persona, as the revision `patch` snapshot / draft baseline. */
function customRowToConfig(row: Persona): PersonaCustomConfig {
  return {
    name: row.name,
    description: row.description,
    avatarEmoji: row.avatarEmoji,
    systemPrompt: row.systemPrompt ?? "",
    model: row.model,
    escalationModel: row.escalationModel,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    enabledTools: (row.enabledTools ?? []) as PersonaCustomConfig["enabledTools"],
    tonePrompt: row.tonePrompt,
    brevityPrompt: row.brevityPrompt,
  }
}

/** Light list item for a custom persona row (roster tail + outbox payload). */
/**
 * The "start from scratch" fork source: a minimal starter prompt (the config
 * schema requires a non-empty one), the companion default model, and nothing
 * else — no tools, slots, or identity to unlearn.
 */
function blankPersonaConfig(name: string): PersonaCustomConfig {
  return {
    name,
    description: null,
    avatarEmoji: null,
    systemPrompt: `You are ${name}.`,
    model: COMPANION_MODEL_ID,
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: [],
    tonePrompt: null,
    brevityPrompt: null,
  }
}

function customRowToListItem(row: Persona): PersonaListItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarEmoji: row.avatarEmoji,
    model: row.model,
    // A personal (`managed_by = 'user'`) row is a `personal` kind; a workspace
    // custom is `custom` (user-scoped-personas).
    kind: row.managedBy === "user" ? "personal" : "custom",
    ownerUserId: row.ownerUserId,
    avatarUrl: row.avatarUrl,
    isCustomized: false,
    status: row.status,
  }
}

/**
 * Reject a write patch touching any field a system persona locks (identity,
 * prompt, temperature, maxTokens, escalationModel). Only toolset, model, and the
 * two style presets are editable for `managed_by: "system"` (roadmap 7.1 product
 * spec). Applies to the WRITE paths only (`setOverride`/`saveDraft`); resolution
 * of already-stored patches stays permissive so a legacy override keeps
 * applying (INV-11 fail-safe — a v0 restore is how a workspace clears one).
 */
function assertSystemPersonaFieldsEditable(patch: PersonaConfigPatch): void {
  const editable = new Set<string>(SYSTEM_PERSONA_EDITABLE_FIELDS as readonly SystemPersonaEditableField[])
  const locked = Object.keys(patch).filter((key) => !editable.has(key))
  if (locked.length > 0) {
    throw new HttpError(`These fields are not editable for a system persona: ${locked.join(", ")}`, {
      status: 400,
      code: "PERSONA_FIELD_LOCKED",
    })
  }
}

function toPersonaListItem(config: PersonaResolvedConfig, isCustomized: boolean): PersonaListItem {
  return {
    id: config.id,
    slug: config.slug,
    name: config.name,
    description: config.description,
    avatarEmoji: config.avatarEmoji,
    model: config.model,
    kind: "builtin",
    ownerUserId: null,
    avatarUrl: null,
    isCustomized,
    // Only visible (non-hidden) built-ins reach list surfaces, and a built-in
    // has no archived state — the broadcast consumer relies on this field.
    status: "active",
  }
}

/**
 * Reads and writes for editable persona (built-in agent) config, layered over
 * the sparse `agent_config_overrides` store. v1 edits code-backed built-ins
 * (Ariadne) only; a workspace override patches the built-in defaults additively.
 * The service owns the commit transaction so the override write and its
 * `agent_config:updated` broadcast land together (INV-7).
 */
export class PersonaConfigService {
  constructor(private deps: Dependencies) {}

  private get pool(): Pool {
    return this.deps.pool
  }

  private get streamService(): StreamService {
    return this.deps.streamService
  }

  private get modelRegistry(): ModelRegistry {
    return this.deps.modelRegistry
  }

  /** Registry-derived chat models an admin may assign (INV-16), labelled by the registry name. */
  private listAvailableModels(): PersonaModelOption[] {
    return this.modelRegistry
      .getModelIds()
      .filter((id) => this.modelRegistry.isChatModel(id))
      .map((id) => ({ id, label: this.modelRegistry.getCapabilities(id)!.name }))
  }

  /**
   * Whether `model` is legal for this persona: any registry chat model, or the
   * persona's own built-in defaults (which stay assignable even if the registry
   * lacks them — a code default is authoritative). Escalation-disabled (`null`)
   * is validated by the caller before reaching here.
   */
  private isModelAssignable(model: string, base: BuiltInAgentConfig): boolean {
    if (model === base.model || model === base.escalationModel) return true
    return this.modelRegistry.isChatModel(model)
  }

  /** Reject an override/draft patch selecting a model outside the assignable set (INV-16). */
  private assertModelsAllowed(patch: PersonaConfigPatch, base: BuiltInAgentConfig): void {
    if (patch.model !== undefined && !this.isModelAssignable(patch.model, base)) {
      throw new HttpError(`Model "${patch.model}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    if (patch.escalationModel != null && !this.isModelAssignable(patch.escalationModel, base)) {
      throw new HttpError(`Escalation model "${patch.escalationModel}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
  }

  /**
   * Reject a custom-persona config selecting a model outside the assignable set
   * (INV-16). The persona's CURRENT model/escalation stay legal even if the
   * registry lacks them (a grandfathered value must remain saveable), mirroring
   * the built-in `base.model` allowance in {@link assertModelsAllowed}.
   */
  private isCustomModelLegal(model: string, current: Persona): boolean {
    return model === current.model || model === current.escalationModel || this.modelRegistry.isChatModel(model)
  }

  private assertCustomModelsAllowed(config: PersonaCustomConfig, current: Persona): void {
    if (!this.isCustomModelLegal(config.model, current)) {
      throw new HttpError(`Model "${config.model}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    if (config.escalationModel != null && !this.isCustomModelLegal(config.escalationModel, current)) {
      throw new HttpError(`Escalation model "${config.escalationModel}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
  }

  /**
   * Validate a custom persona's sparse DRAFT patch: preset keys are locked (a
   * custom uses free-text slots), and any model it selects must be assignable
   * (the row's current values stay legal). Mirrors {@link assertSystemPersonaFieldsEditable}
   * + {@link assertModelsAllowed} for the built-in draft path.
   */
  private assertCustomDraftAllowed(patch: PersonaConfigPatch, current: Persona): void {
    if (patch.tonePreset !== undefined || patch.brevityPreset !== undefined) {
      throw new HttpError("Style presets are not editable for a custom persona", {
        status: 400,
        code: "PERSONA_FIELD_LOCKED",
      })
    }
    if (patch.model !== undefined && !this.isCustomModelLegal(patch.model, current)) {
      throw new HttpError(`Model "${patch.model}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    if (patch.escalationModel != null && !this.isCustomModelLegal(patch.escalationModel, current)) {
      throw new HttpError(`Escalation model "${patch.escalationModel}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
  }

  /** The bound test stream id when it still exists and is unarchived, else null. */
  private async resolveActiveTestStreamId(testStreamId: string | null): Promise<string | null> {
    if (!testStreamId) return null
    const stream = await this.streamService.getStreamById(testStreamId)
    return stream && !stream.archivedAt ? stream.id : null
  }

  /**
   * Archived personas — the roster's Archived disclosure. Caller-aware
   * (user-scoped-personas): an admin gets workspace-archived customs ∪ their own
   * archived personal personas; a non-admin gets only their own archived
   * personal personas.
   */
  async listArchived(workspaceId: string, caller: PersonaCaller): Promise<PersonaListItem[]> {
    const rows = await PersonaRepository.listArchivedCustoms(this.pool, workspaceId, {
      includeWorkspace: caller.isAdmin,
      ownerUserId: caller.userId,
    })
    return rows.map((row) => customRowToListItem(row))
  }

  /**
   * Member-visible list: every editable built-in (resolved and flagged
   * customized) first, then the workspace's ACTIVE customs alphabetically.
   * Archived customs are excluded here (still resolvable by id for history /
   * actor rendering via {@link getConfig}).
   */
  async listVisible(workspaceId: string): Promise<PersonaListItem[]> {
    const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(this.pool, workspaceId)
    const overridesByAgentId = new Map(overrides.map((override) => [override.agentId, override.patch]))
    const builtIns = listVisibleBuiltInAgentConfigs().map((base) => {
      const patch = overridesByAgentId.get(base.id)
      if (patch === undefined) return toPersonaListItem(base, false)
      // Member-visible surface: one corrupt/schema-incompatible override row
      // must not take the whole persona list down for the workspace. Degrade
      // that persona to its code defaults and log; the admin config endpoint
      // stays fail-loud (INV-11) so the bad row still surfaces somewhere.
      try {
        const resolved = applyBuiltInAgentPatch(base, patch, { workspaceId, agentId: base.id })
        return toPersonaListItem(resolved, true)
      } catch (error) {
        logger.warn({ error, workspaceId, agentId: base.id }, "invalid persona override patch; listing code defaults")
        return toPersonaListItem(base, true)
      }
    })
    const customs = await PersonaRepository.listActiveCustoms(this.pool, workspaceId)
    return [...builtIns, ...customs.map(customRowToListItem)]
  }

  /**
   * Resolve a persona the caller may edit, or throw. Built-in and workspace rows
   * resolve for anyone but require workspace-admin (403 otherwise); a personal
   * row resolves ONLY for its owner (viewer-scoped) — a non-owner (admin
   * included) gets a 404, never a 403, so a personal persona's existence never
   * leaks (user-scoped-personas). The single lifecycle authorization gate shared
   * by config read, update, archive, avatar, revisions, drafts, and test-drive.
   */
  private async authorizeEditableOr404(
    workspaceId: string,
    personaId: string,
    caller: PersonaCaller
  ): Promise<EditablePersona> {
    const editable = await PersonaRepository.resolveEditable(this.pool, workspaceId, personaId, {
      userId: caller.userId,
    })
    if (!editable) throw personaNotFound()
    this.assertMayEdit(editable, caller)
    return editable
  }

  /**
   * The shared per-persona rule: a resolved personal row means the caller is its
   * owner (viewer scope guaranteed it), so no admin needed; a built-in or
   * workspace custom is admin-managed.
   */
  private assertMayEdit(editable: EditablePersona, caller: PersonaCaller): void {
    if (editable.kind === "custom" && editable.row.managedBy === "user") return
    if (!caller.isAdmin) throw forbidden()
  }

  /**
   * Admin config detail for one persona, or `null` when the id is not an
   * editable visible built-in (the handler maps null → 404, covering unknown
   * ids and the internal empty shell). `draft` is the CALLER's own unsaved draft
   * (per `(workspace, agent, caller)`), or null if they have none.
   */
  async getConfig(
    workspaceId: string,
    personaId: string,
    caller: PersonaCaller
  ): Promise<PersonaConfigResponse | null> {
    const editable = await PersonaRepository.resolveEditable(this.pool, workspaceId, personaId, {
      userId: caller.userId,
    })
    if (!editable) return null
    this.assertMayEdit(editable, caller)

    const draft = await this.loadCallerDraft(workspaceId, personaId, caller.userId)

    if (editable.kind === "custom") {
      // A custom has no defaults baseline: no per-field customized badge, no
      // reset-to-default. `overrideUpdatedAt` is the row's own OCC token. A
      // personal row is `kind: 'personal'`, a workspace custom `kind: 'custom'`
      // (user-scoped-personas).
      const { row } = editable
      return {
        kind: row.managedBy === "user" ? "personal" : "custom",
        defaults: null,
        overridePatch: null,
        overrideUpdatedAt: row.updatedAt.toISOString(),
        resolved: customRowToResolvedConfig(row),
        draft,
        availableModels: this.listAvailableModels(),
      }
    }

    const { base } = editable
    const detail = await AgentConfigOverrideRepository.findActiveDetailByWorkspaceAndAgent(
      this.pool,
      workspaceId,
      personaId
    )
    const resolved: BuiltInAgentConfig = detail
      ? applyBuiltInAgentPatch(base, detail.patch, { workspaceId, agentId: personaId })
      : base

    let overridePatch: PersonaConfigPatch | null = null
    if (detail) {
      // Re-validate the opaque JSONB through the shared schema (fail loud on a
      // corrupt/hand-edited row per INV-11) and drop the API-withheld `status`
      // so the editor only ever sees editable fields.
      const parsed = builtInAgentConfigPatchSchema.parse(detail.patch)
      delete parsed.status
      overridePatch = parsed
    }

    return {
      kind: "builtin",
      defaults: base,
      overridePatch,
      overrideUpdatedAt: detail?.updatedAt ?? null,
      resolved,
      draft,
      availableModels: this.listAvailableModels(),
    }
  }

  /** The caller's own draft for a persona, with a stale/archived test-stream pointer collapsed to null. */
  private async loadCallerDraft(
    workspaceId: string,
    personaId: string,
    callerId: string
  ): Promise<PersonaDraftState | null> {
    const draftDetail = await PersonaConfigDraftRepository.findByOwner(this.pool, workspaceId, personaId, callerId)
    if (!draftDetail) return null
    // Stored via the write schema (no status); re-validate the opaque JSONB.
    const parsed = personaConfigPatchSchema.parse(draftDetail.patch)
    // "End test chat" only archives the scratchpad — the pointer on the draft
    // row outlives the session — so an archived (or vanished) bound stream reads
    // as no active test chat. Without this a reload would remount the turn-dead
    // scratchpad as an active-looking test chat with no way back to the empty
    // state. `ensureTestStream` mints a fresh stream on the next Start and
    // overwrites the stale pointer then.
    const testStreamId = await this.resolveActiveTestStreamId(draftDetail.testStreamId)
    return { patch: parsed, testStreamId, updatedAt: draftDetail.updatedAt }
  }

  /**
   * Upsert the workspace override for a persona with optimistic concurrency,
   * broadcasting the resolved light persona in the same transaction. Caller
   * must have already confirmed `agentId` is an editable visible built-in.
   */
  async setOverride(
    workspaceId: string,
    agentId: string,
    patch: PersonaConfigPatch,
    expectedUpdatedAt: string | null,
    callerId: string
  ): Promise<SetPersonaOverrideResult> {
    const base = getVisibleBuiltInAgentConfig(agentId)
    if (!base) {
      throw new Error(`setOverride called for non-editable persona ${agentId}`)
    }
    assertSystemPersonaFieldsEditable(patch)
    this.assertModelsAllowed(patch, base)

    // An empty patch means "identical to the built-in defaults" — remove the
    // override entirely (restore-to-default / the history's v0) rather than store
    // an empty row that would read as customized. No revision is appended: the
    // built-in baseline is the implicit v0, and the prior overrides stay in
    // history. A save that resets every field to default lands here too.
    const isReset = Object.keys(patch).length === 0

    const txnResult = await withTransaction(this.pool, async (client) => {
      if (isReset) {
        const result = await AgentConfigOverrideRepository.deleteActive(client, {
          workspaceId,
          agentId,
          expectedUpdatedAt,
        })
        if (result.outcome === "conflict") {
          return result
        }
        const deletedDraft = await PersonaConfigDraftRepository.deleteByOwner(client, workspaceId, agentId, callerId)
        const persona = toPersonaListItem(base, false)
        await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId, persona })
        return {
          outcome: "written" as const,
          persona,
          updatedAt: null,
          testStreamId: deletedDraft?.testStreamId ?? null,
        }
      }

      const result = await AgentConfigOverrideRepository.upsertActive(client, {
        workspaceId,
        agentId,
        patch,
        expectedUpdatedAt,
      })
      if (result.outcome === "conflict") {
        return result
      }

      // The caller's draft is now committed — drop it in the same txn so it can't
      // resurface as a stale test config (D1).
      const deletedDraft = await PersonaConfigDraftRepository.deleteByOwner(client, workspaceId, agentId, callerId)

      const resolved = applyBuiltInAgentPatch(base, patch, { workspaceId, agentId })
      const persona = toPersonaListItem(resolved, true)
      await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId, persona })
      // Append the revision in the same txn as the override + outbox (INV-7): the
      // audit trail can't miss an accepted write. Version is MAX+1, race-safe
      // under the upsert's row lock (INV-20). A restore lands here too, so it
      // records a new revision rather than mutating history.
      await PersonaConfigRevisionRepository.insert(client, {
        workspaceId,
        agentId,
        patch,
        createdByKind: AuthorTypes.USER,
        createdById: callerId,
      })
      return {
        outcome: "written" as const,
        persona,
        updatedAt: result.updatedAt,
        testStreamId: deletedDraft?.testStreamId ?? null,
      }
    })

    if (txnResult.outcome === "written" && txnResult.testStreamId) {
      // Save completes the test session: archive the bound scratchpad like discard
      // does, or every save cycle would strand another active test stream. Only
      // after commit — a 409 must never kill the chat — and best-effort: the
      // override is already committed, so a failed archive leaves an archivable
      // scratchpad, not corrupt state.
      try {
        await this.streamService.archiveStream(txnResult.testStreamId, callerId)
      } catch (error) {
        logger.warn(
          { error, workspaceId, agentId, testStreamId: txnResult.testStreamId },
          "persona override saved but archiving the test stream failed"
        )
      }
    }

    if (txnResult.outcome === "written") {
      const { testStreamId: _testStreamId, ...written } = txnResult
      return written
    }
    return txnResult
  }

  /**
   * The persona's committed revisions, newest-first, capped at
   * {@link REVISION_LIST_LIMIT}. 404s an id that is neither an editable built-in
   * nor a workspace custom. `patch`/`createdById` are returned raw for the
   * frontend to render and resolve (INV-46).
   */
  async listRevisions(workspaceId: string, agentId: string, caller: PersonaCaller): Promise<PersonaConfigRevision[]> {
    await this.authorizeEditableOr404(workspaceId, agentId, caller)
    // Fetch one past the cap so "were older revisions omitted?" is exact rather
    // than a false positive at exactly REVISION_LIST_LIMIT rows.
    const records = await PersonaConfigRevisionRepository.listByWorkspaceAndAgent(
      this.pool,
      workspaceId,
      agentId,
      REVISION_LIST_LIMIT + 1
    )
    if (records.length > REVISION_LIST_LIMIT) {
      logger.warn(
        { workspaceId, agentId, limit: REVISION_LIST_LIMIT },
        "persona revision list hit cap; older revisions omitted"
      )
    }
    return records.slice(0, REVISION_LIST_LIMIT).map(({ agentId: _agentId, ...revision }) => revision)
  }

  /**
   * Restore a prior revision by re-committing its snapshot (D4). Appends a NEW
   * revision and takes the same optimistic-concurrency guard as a normal write,
   * keeping history append-only. A built-in restore re-commits the sparse patch
   * through `setOverride`; a custom restore writes the full-config snapshot
   * through `updateCustom`. A revision foreign to `(workspace, persona)` is a 404;
   * an unknown persona id is a 404.
   */
  async restoreRevision(
    workspaceId: string,
    personaId: string,
    revisionId: string,
    expectedUpdatedAt: string | null,
    caller: PersonaCaller
  ): Promise<SetPersonaOverrideResult | UpdateCustomPersonaResult> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    const revision = await PersonaConfigRevisionRepository.findById(this.pool, workspaceId, revisionId)
    if (!revision || revision.agentId !== personaId) {
      throw new HttpError("Persona revision not found", { status: 404, code: "PERSONA_REVISION_NOT_FOUND" })
    }

    const incompatible = (): HttpError =>
      new HttpError("This revision can no longer be restored — its configuration is out of date", {
        status: 422,
        code: "PERSONA_REVISION_INCOMPATIBLE",
      })

    if (editable.kind === "custom") {
      // A custom revision snapshots the FULL config; re-commit it verbatim
      // through the update path so it appends a new revision like any edit.
      const parsed = personaCustomConfigSchema.safeParse(revision.patch)
      if (!parsed.success) throw incompatible()
      return this.updateCustom(workspaceId, personaId, parsed.data, expectedUpdatedAt, caller)
    }

    // The stored JSONB is opaque; re-validate through the shared schema before
    // re-committing. A revision predates schema changes, so an incompatible
    // field (e.g. an enabledTools entry since retired from AGENT_TOOL_NAMES)
    // means the revision is simply un-restorable — surface a clean 4xx, not a
    // bare ZodError → 500 (INV-32).
    const parsed = personaConfigPatchSchema.safeParse(revision.patch)
    if (!parsed.success) throw incompatible()
    try {
      return await this.setOverride(workspaceId, personaId, parsed.data, expectedUpdatedAt, caller.userId)
    } catch (error) {
      // A legacy revision may carry fields since locked for system personas
      // (e.g. a pre-restriction rename). On a *restore* that is the same "no
      // longer restorable" situation as schema drift — surface the incompatible
      // semantic, not a confusing field-lock error on a history action.
      if (error instanceof HttpError && error.code === "PERSONA_FIELD_LOCKED") {
        throw new HttpError("This revision can no longer be restored — it changes fields that are now locked", {
          status: 422,
          code: "PERSONA_REVISION_INCOMPATIBLE",
        })
      }
      throw error
    }
  }

  /** Upsert the caller's draft patch (race-safe, INV-20). Returns its saved state. */
  async saveDraft(
    workspaceId: string,
    agentId: string,
    caller: PersonaCaller,
    patch: PersonaConfigPatch
  ): Promise<PersonaDraftState> {
    const editable = await this.authorizeEditableOr404(workspaceId, agentId, caller)
    if (editable.kind === "custom") {
      // A custom draft is a sparse diff over the ROW; presets are locked (free
      // text only) and any model it names must be assignable.
      this.assertCustomDraftAllowed(patch, editable.row)
    } else {
      assertSystemPersonaFieldsEditable(patch)
      this.assertModelsAllowed(patch, editable.base)
    }

    const detail = await PersonaConfigDraftRepository.upsert(this.pool, {
      workspaceId,
      agentId,
      createdBy: caller.userId,
      patch,
    })
    return { patch, testStreamId: detail.testStreamId, updatedAt: detail.updatedAt }
  }

  /**
   * Discard the caller's draft and archive its bound test stream. Idempotent: a
   * missing draft is a no-op.
   */
  async discardDraft(workspaceId: string, agentId: string, caller: PersonaCaller): Promise<void> {
    await this.authorizeEditableOr404(workspaceId, agentId, caller)
    const callerId = caller.userId
    const draft = await PersonaConfigDraftRepository.findByOwner(this.pool, workspaceId, agentId, callerId)
    if (!draft) return
    // Archive the bound test stream BEFORE deleting the draft row (the row is the
    // only pointer to that stream): a failed archive then leaves the pointer intact
    // to retry rather than orphaning an active scratchpad. archiveStream owns its
    // own txn, so this is two statements, not one — ordering, not atomicity, is what
    // prevents the orphan. Re-archiving an already-archived stream is a no-op, so a
    // delete that fails after a successful archive self-heals on the next discard.
    if (draft.testStreamId) {
      await this.streamService.archiveStream(draft.testStreamId, callerId)
    }
    await PersonaConfigDraftRepository.deleteByOwner(this.pool, workspaceId, agentId, callerId)
  }

  /**
   * Idempotently create-or-return the caller's bound test scratchpad (D1): a real
   * private scratchpad, companion mode on, persona = the agent, memory OFF (test
   * chats must not feed GAM). Returns the existing bound stream when it's still
   * active; otherwise creates one and binds it. `bindTestStream` upserts the draft
   * row (empty patch when the editor hasn't saved yet) without touching an existing
   * patch, so no separate read-then-write of the draft is needed here (INV-20).
   */
  async ensureTestStream(workspaceId: string, agentId: string, caller: PersonaCaller): Promise<{ streamId: string }> {
    const editable = await this.authorizeEditableOr404(workspaceId, agentId, caller)
    const callerId = caller.userId
    const personaName = editable.kind === "custom" ? editable.row.name : editable.base.name

    const draft = await PersonaConfigDraftRepository.findByOwner(this.pool, workspaceId, agentId, callerId)
    const activeStreamId = await this.resolveActiveTestStreamId(draft?.testStreamId ?? null)
    if (activeStreamId) return { streamId: activeStreamId }

    const stream = await this.streamService.createScratchpad({
      workspaceId,
      displayName: `${personaName} draft test`,
      companionMode: CompanionModes.ON,
      companionPersonaId: agentId,
      memoryMode: MemoryModes.OFF,
      // A workbench, not a channel: the marker keeps it out of the creator's
      // sidebar and workspace stream lists (bootstrap query + live socket add),
      // while it stays fully functional when mounted directly (D6 revision).
      purpose: StreamPurposes.PERSONA_TEST,
      createdBy: callerId,
    })
    await PersonaConfigDraftRepository.bindTestStream(this.pool, {
      workspaceId,
      agentId,
      createdBy: callerId,
      testStreamId: stream.id,
    })
    return { streamId: stream.id }
  }

  /**
   * Fork a built-in or custom persona into a new workspace-owned custom (D:
   * create = copy-then-edit). Copies the source's resolved config and
   * MATERIALIZES its style slots (a preset resolves to the authored fragment
   * text; a custom's free text copies through) — the new custom carries free text
   * only. The avatar image is NOT copied (it's a per-persona upload). Writes the
   * row + a v1 full-config revision + the `agent_config:updated` broadcast in one
   * transaction (INV-7). The slug is workspace-scoped and race-safe: on the
   * `(workspace_id, slug)` unique constraint it retries with a `-2`/`-3` suffix
   * (INV-20). Returns the new light persona.
   */
  async forkPersona(
    workspaceId: string,
    sourcePersonaId: string | null,
    name: string,
    scope: "workspace" | "personal",
    caller: PersonaCaller
  ): Promise<PersonaListItem> {
    // A workspace fork is admin-managed; a personal fork is available to any
    // member and lands owned by the caller (user-scoped-personas).
    if (scope === "workspace" && !caller.isAdmin) throw forbidden()

    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      throw new HttpError("Persona name is required", { status: 400, code: "VALIDATION_ERROR" })
    }

    // Personal scope stamps the owner (→ `managed_by = 'user'`); workspace scope
    // leaves it null (→ `managed_by = 'workspace'`), per insertWorkspacePersona.
    const ownerUserId = scope === "personal" ? caller.userId : undefined
    const config = sourcePersonaId
      ? await this.forkConfigFromSource(workspaceId, sourcePersonaId, trimmedName, caller)
      : blankPersonaConfig(trimmedName)
    const baseSlug = generateSlug(trimmedName) || "persona"

    for (let attempt = 0; attempt < MAX_FORK_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`
      try {
        return await withTransaction(this.pool, async (client) => {
          const row = await PersonaRepository.insertWorkspacePersona(client, {
            workspaceId,
            slug,
            config,
            ownerUserId,
          })
          await PersonaConfigRevisionRepository.insert(client, {
            workspaceId,
            agentId: row.id,
            patch: customRowToConfig(row),
            createdByKind: AuthorTypes.USER,
            createdById: caller.userId,
          })
          const persona = customRowToListItem(row)
          await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId: row.id, persona })
          return persona
        })
      } catch (error) {
        // A slug race lost to the unique constraint: retry with the next suffix.
        // On the final attempt `continue` just ends the loop, falling through to
        // the clean 409 below. Any other error propagates as-is.
        if (!isUniqueViolation(error)) throw error
      }
    }
    throw new HttpError("Could not generate a unique persona slug", { status: 409, code: "PERSONA_SLUG_CONFLICT" })
  }

  /** A fork's starting config: the source's full config with its presets materialized into free-text slots. */
  private async forkConfigFromSource(
    workspaceId: string,
    sourcePersonaId: string,
    name: string,
    caller: PersonaCaller
  ): Promise<PersonaCustomConfig> {
    // Forkable sources: built-ins (with any workspace override applied) and
    // workspace customs, plus the caller's OWN personal personas. `findById` is
    // workspace-scoped and returns personal rows unconditionally (it serves
    // dispatch), so filter another user's personal persona out here — it must
    // 404 as a source, never leak its config (user-scoped-personas).
    const source = await PersonaRepository.findById(this.pool, sourcePersonaId, workspaceId)
    if (!source || (source.managedBy === "user" && source.ownerUserId !== caller.userId)) {
      throw new HttpError("Source persona not found", { status: 404, code: "PERSONA_SOURCE_NOT_FOUND" })
    }
    const slots = resolvePersonaStyleSlots(source)
    return {
      name,
      description: source.description,
      avatarEmoji: source.avatarEmoji,
      systemPrompt: source.systemPrompt ?? "",
      model: source.model,
      escalationModel: source.escalationModel,
      temperature: source.temperature,
      maxTokens: source.maxTokens,
      enabledTools: (source.enabledTools ?? []) as PersonaCustomConfig["enabledTools"],
      tonePrompt: slots.tone ?? null,
      brevityPrompt: slots.brevity ?? null,
    }
  }

  /**
   * Full-field write of a custom persona (customs only — built-ins use
   * `setOverride`). Validates models against the assignable set (the row's
   * current values stay legal), writes the row under optimistic concurrency
   * (409 `PERSONA_OVERRIDE_CONFLICT` on `expectedUpdatedAt` mismatch), and in the
   * same transaction appends a full-config revision, drops the caller's draft,
   * and broadcasts `agent_config:updated` (INV-7). A custom save ALWAYS writes —
   * there is no reset-to-default / v0-floor (a custom has no defaults baseline).
   */
  async updateCustom(
    workspaceId: string,
    personaId: string,
    config: PersonaCustomConfig,
    expectedUpdatedAt: string | null,
    caller: PersonaCaller
  ): Promise<UpdateCustomPersonaResult> {
    const callerId = caller.userId
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()
    this.assertCustomModelsAllowed(config, editable.row)

    const txnResult = await withTransaction(this.pool, async (client) => {
      const result = await PersonaRepository.updateWorkspacePersona(client, {
        workspaceId,
        personaId,
        expectedUpdatedAt,
        config,
        viewer: { userId: callerId },
      })
      if (result.outcome === "conflict") {
        const current = result.current
          ? { config: customRowToResolvedConfig(result.current), updatedAt: result.current.updatedAt.toISOString() }
          : null
        return { outcome: "conflict" as const, current }
      }

      const deletedDraft = await PersonaConfigDraftRepository.deleteByOwner(client, workspaceId, personaId, callerId)
      await PersonaConfigRevisionRepository.insert(client, {
        workspaceId,
        agentId: personaId,
        patch: config,
        createdByKind: AuthorTypes.USER,
        createdById: callerId,
      })
      const persona = customRowToListItem(result.row)
      await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId: personaId, persona })
      return {
        outcome: "written" as const,
        persona,
        updatedAt: result.updatedAt,
        testStreamId: deletedDraft?.testStreamId ?? null,
      }
    })

    if (txnResult.outcome === "written" && txnResult.testStreamId) {
      // Save completes the test session — archive the bound scratchpad, best-effort
      // and post-commit only (a 409 must never kill the chat; the row is already
      // committed so a failed archive just leaves an archivable scratchpad).
      try {
        await this.streamService.archiveStream(txnResult.testStreamId, callerId)
      } catch (error) {
        logger.warn(
          { error, workspaceId, personaId, testStreamId: txnResult.testStreamId },
          "custom persona saved but archiving the test stream failed"
        )
      }
    }

    if (txnResult.outcome === "written") {
      const { testStreamId: _testStreamId, ...written } = txnResult
      return written
    }
    return txnResult
  }

  /**
   * Archive or unarchive a custom persona (customs only). Flips the row status
   * and broadcasts `agent_config:updated` in one transaction. An archived custom
   * drops out of {@link listVisible} / the picker but stays resolvable by id for
   * history and actor rendering; a stream still pointing at it degrades to the
   * built-in default at dispatch (existing behavior).
   */
  async setCustomStatus(
    workspaceId: string,
    personaId: string,
    status: "active" | "archived",
    caller: PersonaCaller
  ): Promise<PersonaListItem> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()

    return withTransaction(this.pool, async (client) => {
      const row = await PersonaRepository.setStatus(client, {
        workspaceId,
        personaId,
        status,
        viewer: { userId: caller.userId },
      })
      if (!row) throw personaNotFound()
      const persona = customRowToListItem(row)
      await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId: personaId, persona })
      return persona
    })
  }

  /**
   * Set (`avatarBasePath` non-null) or clear (`null`) a custom persona's avatar
   * image pointer (customs only — built-ins have no image avatar → 400). Writes
   * the row and broadcasts `agent_config:updated` in one transaction (INV-7). The
   * caller (handler) owns the S3 processing outside this txn (INV-41) and the
   * post-commit deletion of the returned `previousAvatarUrl`'s files. Clearing an
   * already-empty avatar short-circuits without a write (no spurious broadcast),
   * mirroring the bot remove-avatar no-op.
   */
  async setCustomAvatar(
    workspaceId: string,
    personaId: string,
    avatarBasePath: string | null,
    caller: PersonaCaller
  ): Promise<{ persona: PersonaListItem; previousAvatarUrl: string | null; updatedAt: string }> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()

    const previousAvatarUrl = editable.row.avatarUrl
    if (avatarBasePath === null && previousAvatarUrl === null) {
      return {
        persona: customRowToListItem(editable.row),
        previousAvatarUrl: null,
        updatedAt: editable.row.updatedAt.toISOString(),
      }
    }

    // The UPDATE trigger bumps updated_at (the OCC token Save asserts against), so
    // the new token rides the response — the client adopts it synchronously instead
    // of waiting for the broadcast-driven refetch, else an edit+Save inside that
    // window 409s spuriously.
    const { persona, updatedAt } = await withTransaction(this.pool, async (client) => {
      const row = await PersonaRepository.updateAvatarUrl(client, {
        workspaceId,
        personaId,
        avatarUrl: avatarBasePath,
        viewer: { userId: caller.userId },
      })
      if (!row) throw personaNotFound()
      const item = customRowToListItem(row)
      await OutboxRepository.insert(client, "agent_config:updated", { workspaceId, agentId: personaId, persona: item })
      return { persona: item, updatedAt: row.updatedAt.toISOString() }
    })
    return { persona, previousAvatarUrl, updatedAt }
  }
}
