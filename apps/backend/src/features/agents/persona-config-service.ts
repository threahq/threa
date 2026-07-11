import type { Pool } from "pg"
import type { ModelRegistry } from "@threa/agent-runtime"
import {
  personaConfigPatchSchema,
  CompanionModes,
  MemoryModes,
  StreamPurposes,
  type PersonaConfigPatch,
  type PersonaConfigResponse,
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

export type SetPersonaOverrideResult =
  | { outcome: "written"; persona: PersonaListItem; updatedAt: string }
  | { outcome: "conflict"; current: AgentConfigOverrideDetail | null }

function toPersonaListItem(config: PersonaResolvedConfig, isCustomized: boolean): PersonaListItem {
  return {
    id: config.id,
    slug: config.slug,
    name: config.name,
    description: config.description,
    avatarEmoji: config.avatarEmoji,
    model: config.model,
    isCustomized,
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

  /** The bound test stream id when it still exists and is unarchived, else null. */
  private async resolveActiveTestStreamId(testStreamId: string | null): Promise<string | null> {
    if (!testStreamId) return null
    const stream = await this.streamService.getStreamById(testStreamId)
    return stream && !stream.archivedAt ? stream.id : null
  }

  /** Member-visible list: every editable built-in, resolved and flagged customized. */
  async listVisible(workspaceId: string): Promise<PersonaListItem[]> {
    const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(this.pool, workspaceId)
    const overridesByAgentId = new Map(overrides.map((override) => [override.agentId, override.patch]))
    return listVisibleBuiltInAgentConfigs().map((base) => {
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
  }

  /**
   * Admin config detail for one persona, or `null` when the id is not an
   * editable visible built-in (the handler maps null → 404, covering unknown
   * ids and the internal empty shell). `draft` is the CALLER's own unsaved draft
   * (per `(workspace, agent, caller)`), or null if they have none.
   */
  async getConfig(workspaceId: string, personaId: string, callerId: string): Promise<PersonaConfigResponse | null> {
    const base = getVisibleBuiltInAgentConfig(personaId)
    if (!base) return null

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

    const draftDetail = await PersonaConfigDraftRepository.findByOwner(this.pool, workspaceId, personaId, callerId)
    let draft: PersonaDraftState | null = null
    if (draftDetail) {
      // Stored via the write schema (no status); re-validate the opaque JSONB.
      const parsed = personaConfigPatchSchema.parse(draftDetail.patch)
      // "End test chat" only archives the scratchpad — the pointer on the draft
      // row outlives the session — so an archived (or vanished) bound stream reads
      // as no active test chat. Without this a reload would remount the turn-dead
      // scratchpad as an active-looking test chat with no way back to the empty
      // state. `ensureTestStream` mints a fresh stream on the next Start and
      // overwrites the stale pointer then.
      const testStreamId = await this.resolveActiveTestStreamId(draftDetail.testStreamId)
      draft = { patch: parsed, testStreamId, updatedAt: draftDetail.updatedAt }
    }

    return {
      defaults: base,
      overridePatch,
      overrideUpdatedAt: detail?.updatedAt ?? null,
      resolved,
      draft,
      availableModels: this.listAvailableModels(),
    }
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
    this.assertModelsAllowed(patch, base)

    const txnResult = await withTransaction(this.pool, async (client) => {
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

  /** Upsert the caller's draft patch (race-safe, INV-20). Returns its saved state. */
  async saveDraft(
    workspaceId: string,
    agentId: string,
    callerId: string,
    patch: PersonaConfigPatch
  ): Promise<PersonaDraftState> {
    const base = getVisibleBuiltInAgentConfig(agentId)
    if (!base) {
      throw new Error(`saveDraft called for non-editable persona ${agentId}`)
    }
    this.assertModelsAllowed(patch, base)

    const detail = await PersonaConfigDraftRepository.upsert(this.pool, {
      workspaceId,
      agentId,
      createdBy: callerId,
      patch,
    })
    return { patch, testStreamId: detail.testStreamId, updatedAt: detail.updatedAt }
  }

  /**
   * Discard the caller's draft and archive its bound test stream. Idempotent: a
   * missing draft is a no-op.
   */
  async discardDraft(workspaceId: string, agentId: string, callerId: string): Promise<void> {
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
  async ensureTestStream(workspaceId: string, agentId: string, callerId: string): Promise<{ streamId: string }> {
    const base = getVisibleBuiltInAgentConfig(agentId)
    if (!base) {
      throw new Error(`ensureTestStream called for non-editable persona ${agentId}`)
    }

    const draft = await PersonaConfigDraftRepository.findByOwner(this.pool, workspaceId, agentId, callerId)
    const activeStreamId = await this.resolveActiveTestStreamId(draft?.testStreamId ?? null)
    if (activeStreamId) return { streamId: activeStreamId }

    const stream = await this.streamService.createScratchpad({
      workspaceId,
      displayName: `${base.name} draft test`,
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
}
