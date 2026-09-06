import type { Pool } from "pg"
import { generateSlug } from "@threahq/backend-common"
import type { ModelRegistry } from "@threahq/agent-runtime"
import {
  AttachmentSafetyStatuses,
  personaConfigPatchSchema,
  personaCustomConfigSchema,
  SYSTEM_PERSONA_EDITABLE_FIELDS,
  type SystemPersonaEditableField,
  AuthorTypes,
  CompanionModes,
  MemoryModes,
  StreamPurposes,
  PERSONA_ATTACHMENT_MAX_COUNT,
  PERSONA_ATTACHMENT_MAX_SIZE_BYTES,
  PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES,
  isPersonaAttachmentMimeAllowed,
  type PersonaAttachmentItem,
  type PersonaAttachmentProcessingStatus,
  type PersonaConfigPatch,
  type PersonaConfigResponse,
  type PersonaConfigRevision,
  type PersonaCustomConfig,
  type PersonaDraftState,
  type PersonaListItem,
  type PersonaModelOption,
  type PersonaResolvedConfig,
} from "@threahq/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import { attachmentId as generateAttachmentId } from "../../lib/id"
import {
  isAttachmentReadableViaShareOrReference,
  unboundAttachmentBlockedForCaller,
  type Attachment,
  type AttachmentService,
} from "../attachments"
import {
  personaAttachmentExtractionFailed,
  PersonaAttachmentRepository,
  type PersonaAttachmentListItem,
} from "./persona-attachment-repository"
import { planPersonaKnowledge, type PersonaKnowledgePlan } from "./companion/prompt/persona-knowledge-plan"
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
  attachmentService: AttachmentService
  /**
   * The workspace's governed model set (`resolveSubagentModels` over workspace
   * settings, wired in server.ts). A function rather than the settings service
   * itself: workspace-settings already imports this feature for persona
   * validation, so the dependency only goes one way.
   */
  loadGovernedModels: (workspaceId: string) => Promise<string[]>
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

function personaAttachmentLimitReached(): HttpError {
  return new HttpError(`A persona can have at most ${PERSONA_ATTACHMENT_MAX_COUNT} context attachments`, {
    status: 400,
    code: "PERSONA_ATTACHMENT_LIMIT",
  })
}

function personaAttachmentNotFound(): HttpError {
  return new HttpError("Persona attachment not found", { status: 404, code: "PERSONA_ATTACHMENT_NOT_FOUND" })
}

/**
 * The copy-on-attach source is missing, cross-workspace, or one the caller may
 * not read. A single 404 for all three so a private file's existence never leaks
 * (matching the download gate's non-leak posture) — the copy is never performed.
 */
function personaAttachmentSourceNotFound(): HttpError {
  return new HttpError("Source attachment not found", {
    status: 404,
    code: "PERSONA_ATTACHMENT_SOURCE_NOT_FOUND",
  })
}

/** Derive the structured wire status (INV-46) from the extraction/pipeline state. */
function personaAttachmentProcessingStatus(item: PersonaAttachmentListItem): PersonaAttachmentProcessingStatus {
  if (item.hasExtraction) return "ready"
  if (personaAttachmentExtractionFailed(item)) return "failed"
  return "processing"
}

function toPersonaAttachmentItem(item: PersonaAttachmentListItem, plan: PersonaKnowledgePlan): PersonaAttachmentItem {
  const processingStatus = personaAttachmentProcessingStatus(item)
  return {
    id: item.attachmentId,
    filename: item.filename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    processingStatus,
    // How this file is referenced in the persona's context (INV-46). Meaningless
    // until extraction lands — there is no content to plan a mode from — so it is
    // null for any non-ready row.
    contextMode: processingStatus === "ready" ? plan.mode : null,
    position: item.position,
    createdAt: item.createdAt.toISOString(),
  }
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
 * prompt, temperature, maxTokens). Only toolset, the two models, and the two
 * style presets are editable for `managed_by: "system"` (roadmap 7.1 product
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

/**
 * Escalation spends money nobody picks per turn, so every persona kind —
 * built-in, workspace custom, personal — answers to the workspace's delegation
 * set, not to the whole registry. Without this a member's personal persona
 * would be the way around the admin's cost control.
 */
function ungovernedEscalation(model: string): HttpError {
  return new HttpError(`Escalation model "${model}" is not in this workspace's delegation model set`, {
    status: 400,
    code: "UNSUPPORTED_PERSONA_MODEL",
  })
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

  private get attachmentService(): AttachmentService {
    return this.deps.attachmentService
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

  /**
   * Reject an override/draft patch selecting a model outside the assignable set
   * (INV-16), and an escalation outside the workspace's GOVERNED set.
   *
   * Escalation is the one persona field that spends money the admin did not
   * pick per turn, so it answers to the same list as subagent delegation
   * (`subagentModels`) rather than to the whole registry. The persona's current
   * escalation stays legal whatever the list says — a workspace that narrows
   * its set must still be able to save an unrelated toolset edit, and clearing
   * escalation to `null` is always available as the way out.
   */
  private async assertModelsAllowed(
    workspaceId: string,
    agentId: string,
    patch: PersonaConfigPatch,
    base: BuiltInAgentConfig
  ): Promise<void> {
    if (patch.model !== undefined && !this.isModelAssignable(patch.model, base)) {
      throw new HttpError(`Model "${patch.model}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    const escalation = patch.escalationModel
    if (escalation == null || escalation === base.escalationModel) return
    if (!this.isModelAssignable(escalation, base)) {
      throw new HttpError(`Escalation model "${escalation}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    const governed = await this.deps.loadGovernedModels(workspaceId)
    if (governed.includes(escalation)) return
    if (escalation === (await this.resolveCurrentEscalationModel(workspaceId, agentId, base))) return
    throw ungovernedEscalation(escalation)
  }

  /**
   * The built-in's escalation model as it stands right now — the stored
   * override's value, else the code default. Read outside the write
   * transaction: it only widens what is legal, and the write itself is guarded
   * by optimistic concurrency.
   */
  private async resolveCurrentEscalationModel(
    workspaceId: string,
    agentId: string,
    base: BuiltInAgentConfig
  ): Promise<string | null> {
    const detail = await AgentConfigOverrideRepository.findActiveDetailByWorkspaceAndAgent(
      this.pool,
      workspaceId,
      agentId
    )
    if (!detail) return base.escalationModel
    return applyBuiltInAgentPatch(base, detail.patch, { workspaceId, agentId }).escalationModel
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

  private async assertCustomModelsAllowed(
    workspaceId: string,
    config: PersonaCustomConfig,
    current: Persona
  ): Promise<void> {
    if (!this.isCustomModelLegal(config.model, current)) {
      throw new HttpError(`Model "${config.model}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    await this.assertCustomEscalationAllowed(workspaceId, config.escalationModel, current)
  }

  /**
   * A custom (or personal) persona's escalation model: assignable AND in the
   * workspace's governed set, with the row's own current value always legal so a
   * narrowed set never blocks an unrelated edit. Same rule as the built-in path
   * — a personal persona must not be the loophole around the admin's set.
   */
  private async assertCustomEscalationAllowed(
    workspaceId: string,
    escalation: string | null | undefined,
    current: Persona
  ): Promise<void> {
    if (escalation == null) return
    if (!this.isCustomModelLegal(escalation, current)) {
      throw new HttpError(`Escalation model "${escalation}" is not an assignable persona model`, {
        status: 400,
        code: "UNSUPPORTED_PERSONA_MODEL",
      })
    }
    if (escalation === current.escalationModel) return
    const governed = await this.deps.loadGovernedModels(workspaceId)
    if (governed.includes(escalation)) return
    throw ungovernedEscalation(escalation)
  }

  /**
   * Validate a custom persona's sparse DRAFT patch: preset keys are locked (a
   * custom uses free-text slots), and any model it selects must be assignable
   * (the row's current values stay legal). Mirrors {@link assertSystemPersonaFieldsEditable}
   * + {@link assertModelsAllowed} for the built-in draft path.
   */
  private async assertCustomDraftAllowed(
    workspaceId: string,
    patch: PersonaConfigPatch,
    current: Persona
  ): Promise<void> {
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
    await this.assertCustomEscalationAllowed(workspaceId, patch.escalationModel, current)
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
      const attachments = await this.listAttachments(workspaceId, personaId)
      return {
        kind: row.managedBy === "user" ? "personal" : "custom",
        defaults: null,
        overridePatch: null,
        overrideUpdatedAt: row.updatedAt.toISOString(),
        resolved: customRowToResolvedConfig(row),
        draft,
        availableModels: this.listAvailableModels(),
        attachments,
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
      // A built-in has no owned row to bind attachments to (persona-context-
      // attachments); always empty.
      attachments: [],
    }
  }

  /** A custom/personal persona's context attachments in position order, as wire items. */
  private async listAttachments(workspaceId: string, personaId: string): Promise<PersonaAttachmentItem[]> {
    const rows = await PersonaAttachmentRepository.listForPersona(this.pool, workspaceId, personaId)
    // Derive each row's context mode from the SAME budget planner the dispatch
    // prompt uses, fed the extraction lengths in position order (INV-29/43) — the
    // label the editor shows can't drift from what the prompt actually carries.
    const plans = planPersonaKnowledge(
      rows.map((row) => ({
        fullTextChars: row.fullTextChars,
        summaryChars: row.summaryChars,
        extractionFailed: personaAttachmentExtractionFailed(row),
      }))
    )
    return rows.map((row, index) => toPersonaAttachmentItem(row, plans[index]!))
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
    await this.assertModelsAllowed(workspaceId, agentId, patch, base)

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
        await this.streamService.archiveStream(txnResult.testStreamId, workspaceId, callerId)
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

    // A legacy revision may carry fields since locked for system personas (a
    // pre-restriction rename), or an escalation model the workspace's delegation
    // set no longer carries. On a *restore* both are the same "no longer
    // restorable" situation as schema drift — surface the incompatible semantic,
    // not a field-lock or model error on a history action. A revision whose
    // escalation is still governed (or is the persona's current value) restores
    // normally, because the write path admits it.
    const asIncompatible = (error: unknown): never => {
      if (
        error instanceof HttpError &&
        (error.code === "PERSONA_FIELD_LOCKED" || error.code === "UNSUPPORTED_PERSONA_MODEL")
      ) {
        throw new HttpError("This revision can no longer be restored — its configuration is no longer allowed", {
          status: 422,
          code: "PERSONA_REVISION_INCOMPATIBLE",
        })
      }
      throw error
    }

    if (editable.kind === "custom") {
      // A custom revision snapshots the FULL config; re-commit it verbatim
      // through the update path so it appends a new revision like any edit.
      const parsed = personaCustomConfigSchema.safeParse(revision.patch)
      if (!parsed.success) throw incompatible()
      return this.updateCustom(workspaceId, personaId, parsed.data, expectedUpdatedAt, caller).catch(asIncompatible)
    }

    // The stored JSONB is opaque; re-validate through the shared schema before
    // re-committing. A revision predates schema changes, so an incompatible
    // field (e.g. an enabledTools entry since retired from AGENT_TOOL_NAMES)
    // means the revision is simply un-restorable — surface a clean 4xx, not a
    // bare ZodError → 500 (INV-32).
    const parsed = personaConfigPatchSchema.safeParse(revision.patch)
    if (!parsed.success) throw incompatible()
    return this.setOverride(workspaceId, personaId, parsed.data, expectedUpdatedAt, caller.userId).catch(asIncompatible)
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
      await this.assertCustomDraftAllowed(workspaceId, patch, editable.row)
    } else {
      assertSystemPersonaFieldsEditable(patch)
      await this.assertModelsAllowed(workspaceId, agentId, patch, editable.base)
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
      await this.streamService.archiveStream(draft.testStreamId, workspaceId, callerId)
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
   * transaction (INV-7). The slug is scoped per fork target — workspace forks
   * collide workspace-wide (`personas_shared_slug_key`), personal forks only
   * within the owner's own namespace (`personas_personal_slug_key`) — and
   * race-safe either way: a 23505 from whichever partial unique index the scope
   * hits retries with a `-2`/`-3` suffix (INV-20). Returns the new light persona.
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
    // A fork copies the source's config, and `POST /personas` is open to any
    // member for a personal fork — so copying an ungoverned escalation verbatim
    // would launder it into a fresh row, which the ∪-current allowance then
    // blesses on every later write. Clamp it to null instead of refusing the
    // fork: an admin narrowing the delegation set must not break an unrelated
    // member action, and the owner can re-pick from the governed set.
    const governed = await this.deps.loadGovernedModels(workspaceId)
    const escalationModel =
      source.escalationModel && governed.includes(source.escalationModel) ? source.escalationModel : null
    return {
      name,
      description: source.description,
      avatarEmoji: source.avatarEmoji,
      systemPrompt: source.systemPrompt ?? "",
      model: source.model,
      escalationModel,
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
    await this.assertCustomModelsAllowed(workspaceId, config, editable.row)

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
        await this.streamService.archiveStream(txnResult.testStreamId, workspaceId, callerId)
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

  /**
   * Bind an already-uploaded workspace attachment to a custom/personal persona as
   * context knowledge (persona-context-attachments). The bytes reach S3 through the
   * shared composer upload transport (reserve → content → scan/extract), so this is
   * the persona-ness step only — there is exactly ONE frontend upload path (INV-35/37).
   * Authorization is the persona edit gate exactly ({@link authorizeEditableOr404}):
   * a workspace persona needs admin, a personal persona needs its owner (a non-owner —
   * admin included — already 404'd); a built-in has no owned row → 400 `PERSONA_NOT_CUSTOM`.
   *
   * The attachment must be the caller's OWN unbound, settled, allowed-type upload:
   * a foreign / cross-workspace / other-user row 404s (never leak another's unbound
   * upload, matching the generic serve gate), a message-bound row 400s, a not-yet-
   * settled (`pending_upload`) or quarantined row 400s (a client cannot bind mid-
   * upload), and the persona mime/size rules — which the generic reserve path does
   * NOT enforce (it allows 100MB / any type) — are applied here against the stored
   * row. Binding is cap-guarded race-safely by {@link PersonaAttachmentRepository.insertBinding}
   * (INV-20).
   */
  async bindAttachment(
    workspaceId: string,
    personaId: string,
    caller: PersonaCaller,
    attachmentId: string
  ): Promise<PersonaAttachmentItem> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()

    const attachment = await this.attachmentService.getById(attachmentId)
    // A missing row, a cross-workspace row, or one uploaded by someone else all
    // 404 — never leak (or bind) another user's private unbound upload, matching
    // `unboundAttachmentBlockedForCaller` on the generic serve path.
    if (!attachment || attachment.workspaceId !== workspaceId || attachment.uploadedBy !== caller.userId) {
      throw personaAttachmentNotFound()
    }
    // Only a free-floating workspace upload is bindable — never a file already
    // attached to a message (which carries real message provenance).
    if (attachment.streamId || attachment.messageId) {
      throw new HttpError("This file is already attached to a message", {
        status: 400,
        code: "PERSONA_ATTACHMENT_BOUND",
      })
    }
    // Must be a settled, scanned-clean upload: `getSharingBlockReason` is the same
    // settled-and-safe predicate the send path uses (INV-35), so a `pending_upload`
    // (mid-transfer) or quarantined row is rejected rather than bound.
    const blockReason = this.attachmentService.getSharingBlockReason(attachment)
    if (blockReason) {
      throw new HttpError(blockReason, { status: 400, code: "PERSONA_ATTACHMENT_NOT_SETTLED" })
    }
    // The generic reserve path allows 100MB / any mime; the persona rules apply
    // here at bind, against the stored row's real metadata (INV-11 — loud).
    this.assertPersonaMimeAndSizeEligible(attachment)

    let binding
    try {
      binding = await withTransaction(this.pool, async (client) =>
        PersonaAttachmentRepository.insertBinding(client, {
          attachmentId,
          workspaceId,
          personaId,
          createdBy: caller.userId,
          maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
        })
      )
    } catch (error) {
      // The attachment id is already the PK of a persona_attachments row (bound
      // to this or another persona). Do NOT delete it — it belongs to that
      // binding; surface a clean 409 for the client to repick.
      if (isUniqueViolation(error)) {
        throw new HttpError("This file is already attached to a persona", {
          status: 409,
          code: "PERSONA_ATTACHMENT_ALREADY_BOUND",
        })
      }
      throw error
    }
    if (!binding) {
      // Cap reached. A settled-but-unbound attachment is NEVER reaped by the
      // upload sweep — its `attachment_uploads` tracking row is deleted at settle,
      // and the sweep only reaps rows that still have one — so hard-delete it here
      // to avoid a permanent orphan. `deleteIfUnbound` so a message that claimed
      // the file between the cap check and now keeps its bytes (INV-20).
      await this.attachmentService
        .deleteIfUnbound(attachmentId)
        .then((result) => {
          if (!result.deleted) {
            logger.info({ attachmentId }, "persona cap-race cleanup skipped — file was claimed by a message")
          }
        })
        .catch((err) => {
          logger.error({ err, attachmentId }, "failed to clean up persona attachment after cap race")
        })
      throw personaAttachmentLimitReached()
    }

    return {
      id: attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      // Extraction runs off the upload's settle event; it may still be in flight,
      // so no content mode can be planned yet. The config refetch reconciles.
      processingStatus: "processing",
      contextMode: null,
      position: binding.position,
      createdAt: binding.createdAt.toISOString(),
    }
  }

  /** The persona mime allowlist + per-file size cap, applied against a stored row (INV-11 — loud). */
  private assertPersonaMimeAndSizeEligible(attachment: Pick<Attachment, "mimeType" | "sizeBytes">): void {
    if (!isPersonaAttachmentMimeAllowed(attachment.mimeType)) {
      throw new HttpError(
        `File type "${attachment.mimeType}" is not allowed. Allowed: text/*, ${PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES.join(", ")}`,
        { status: 400, code: "PERSONA_ATTACHMENT_INVALID_TYPE" }
      )
    }
    if (attachment.sizeBytes > PERSONA_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new HttpError(`File exceeds the ${PERSONA_ATTACHMENT_MAX_SIZE_BYTES}-byte limit`, {
        status: 400,
        code: "PERSONA_ATTACHMENT_TOO_LARGE",
      })
    }
  }

  /**
   * The exact readability chain the download/content handlers use (INV-35), not a
   * reimplementation: a bound source resolves through direct stream access with
   * the share-grant / inline-reference fallback; an unbound source (someone's
   * pending upload) is private to its uploader. Throws a non-leaking 404 when the
   * caller may not read it — so the copy is never performed for a file the caller
   * can't already see.
   */
  private async assertCallerCanReadSource(source: Attachment, workspaceId: string, userId: string): Promise<void> {
    if (source.streamId) {
      const accessible = await this.streamService.tryAccess(source.streamId, workspaceId, userId)
      if (accessible) return
      const granted = await isAttachmentReadableViaShareOrReference(this.pool, source, workspaceId, userId)
      if (granted) return
      throw personaAttachmentSourceNotFound()
    }
    if (unboundAttachmentBlockedForCaller(source, userId)) throw personaAttachmentSourceNotFound()
  }

  /**
   * Attach an EXISTING workspace file to a custom/personal persona as context
   * knowledge by COPYING it (knowledge-by-reference). Attachments are immutable,
   * so an independent copy IS reference semantics from the user's view and keeps
   * every ownership rule intact: the persona owns its copy outright (message/
   * stream NULL forever, uploader-only, hard-delete safe, cap-guarded), and the
   * source message's file can never be mutated or deleted out from under the
   * persona. `attachment_references` (row-sharing) is deliberately NOT used.
   *
   * Flow: the persona edit gate (as bind); load the source workspace-scoped
   * (404 if missing/cross-workspace); the caller must be able to READ the source
   * ({@link assertCallerCanReadSource} — the download handlers' exact chain);
   * eligibility (CLEAN only, not e2e, persona mime + size against the SOURCE);
   * server-side copy + extraction copy / pipeline kick
   * ({@link AttachmentService.copyForPersona}); then the existing cap-guarded
   * {@link PersonaAttachmentRepository.insertBinding} with the existing cap-loss
   * cleanup ({@link AttachmentService.deleteIfUnbound}). A copy with a copied
   * extraction is `ready` immediately with a real contextMode; a copy that kicked
   * the pipeline shows `processing`.
   */
  async attachFromExisting(
    workspaceId: string,
    personaId: string,
    caller: PersonaCaller,
    sourceAttachmentId: string
  ): Promise<PersonaAttachmentItem> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()

    const source = await this.attachmentService.getById(sourceAttachmentId)
    if (!source || source.workspaceId !== workspaceId) throw personaAttachmentSourceNotFound()

    await this.assertCallerCanReadSource(source, workspaceId, caller.userId)

    // Eligibility against the SOURCE row (INV-11 — loud, structured). CLEAN only:
    // rejects e2e_unscanned / pending scan / quarantined; the explicit e2e_only
    // guard is belt-and-suspenders (an e2e file is never CLEAN anyway).
    if (source.safetyStatus !== AttachmentSafetyStatuses.CLEAN || source.e2eOnly) {
      throw new HttpError("This file cannot be attached as persona knowledge (not a scanned-clean file)", {
        status: 400,
        code: "PERSONA_ATTACHMENT_SOURCE_NOT_CLEAN",
      })
    }
    this.assertPersonaMimeAndSizeEligible(source)

    const newId = generateAttachmentId()
    const copy = await this.attachmentService.copyForPersona({
      source,
      newId,
      uploadedBy: caller.userId,
    })

    let binding
    try {
      binding = await withTransaction(this.pool, async (client) =>
        PersonaAttachmentRepository.insertBinding(client, {
          attachmentId: newId,
          workspaceId,
          personaId,
          createdBy: caller.userId,
          maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
        })
      )
    } catch (error) {
      // The copy is a brand-new id, so a unique-PK collision cannot be a real
      // "already bound" case — clean up the just-created copy and rethrow.
      await this.attachmentService.deleteIfUnbound(newId).catch((err) => {
        logger.error({ err, attachmentId: newId }, "failed to clean up persona copy after bind error")
      })
      throw error
    }
    if (!binding) {
      // Cap reached. The copy is unbound, so hard-delete it cleanly (its bytes +
      // extraction go with it) — race-safe so a message that somehow claimed it
      // keeps its bytes (INV-20; mirrors bind's cap-loss cleanup).
      await this.attachmentService.deleteIfUnbound(newId).catch((err) => {
        logger.error({ err, attachmentId: newId }, "failed to clean up persona copy after cap race")
      })
      throw personaAttachmentLimitReached()
    }

    // Return the item exactly as the config GET would render it — re-read through
    // the same budget planner so the contextMode can't drift (decision 2g): a
    // copied extraction yields a real mode now; a kicked pipeline is `processing`.
    const items = await this.listAttachments(workspaceId, personaId)
    const created = items.find((item) => item.id === newId)
    if (created) return created

    // Unreachable in practice (we just bound it); construct a safe fallback
    // rather than throw after a committed copy+bind (the operation succeeded).
    return {
      id: newId,
      filename: copy.filename,
      mimeType: copy.mimeType,
      sizeBytes: copy.sizeBytes,
      processingStatus: "processing",
      contextMode: null,
      position: binding.position,
      createdAt: binding.createdAt.toISOString(),
    }
  }

  /**
   * Remove a persona context attachment: verify the binding under the persona
   * edit gate, delete it, then hard-delete the attachment row + extraction + S3
   * object — but only while it is still unbound ({@link AttachmentService.deleteIfUnbound}),
   * so a file a message claimed in the meantime keeps its bytes (INV-20). The
   * binding delete runs first so a failure mid-way leaves at worst an unbound
   * (invisible) attachment row, never a binding pointing at deleted bytes.
   */
  async removeAttachment(
    workspaceId: string,
    personaId: string,
    attachmentId: string,
    caller: PersonaCaller
  ): Promise<void> {
    const editable = await this.authorizeEditableOr404(workspaceId, personaId, caller)
    if (editable.kind !== "custom") throw customsOnly()

    const deleted = await PersonaAttachmentRepository.deleteBinding(this.pool, workspaceId, personaId, attachmentId)
    if (!deleted) throw personaAttachmentNotFound()

    // The binding is gone — the user-visible action succeeded. Hard-delete the
    // file only while it is still unbound: a message that claimed it between the
    // binding delete and now keeps its bytes (INV-20), we just log the skip.
    const result = await this.attachmentService.deleteIfUnbound(attachmentId)
    if (!result.deleted) {
      logger.info(
        { workspaceId, personaId, attachmentId },
        "persona attachment unbound but file left intact — claimed by a message"
      )
    }
  }
}
