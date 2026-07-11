import type { Pool } from "pg"
import type { ModelRegistry } from "@threa/agent-runtime"
import type { AvailablePersonaModel, ListWorkspacePersonasResponse, WorkspacePersonaSummary } from "@threa/types"
import { HttpError } from "../../lib/errors"
import {
  applyBuiltInAgentPatch,
  builtInAgentConfigPatchSchema,
  getBuiltInAgentConfig,
  listVisibleBuiltInAgentConfigs,
  type BuiltInAgentConfig,
} from "./built-in-agents"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"

interface Dependencies {
  pool: Pool
  modelRegistry: ModelRegistry
}

/**
 * Workspace-facing configuration of code-backed built-in personas (roadmap 7.1 subset).
 *
 * Today the only writable field is `model` — a temporary control until the full persona
 * editor ships. Writes land in `agent_config_overrides` and take effect on the persona's
 * next turn via `resolveBuiltInPersona`; no cache invalidation is needed.
 */
export class PersonaConfigService {
  private readonly pool: Pool
  private readonly modelRegistry: ModelRegistry

  constructor({ pool, modelRegistry }: Dependencies) {
    this.pool = pool
    this.modelRegistry = modelRegistry
  }

  async listWorkspacePersonas(workspaceId: string): Promise<ListWorkspacePersonasResponse> {
    const overrides = await AgentConfigOverrideRepository.listActiveByWorkspace(this.pool, workspaceId)
    const patchByAgentId = new Map(overrides.map((o) => [o.agentId, o.patch]))

    const personas = listVisibleBuiltInAgentConfigs().map((base) =>
      this.buildSummary(base, patchByAgentId.get(base.id), workspaceId)
    )

    return { personas, availableModels: this.listAssignableModels() }
  }

  /**
   * Set or clear the workspace's model override for a built-in persona.
   * `model: null` resets to the code-backed default.
   */
  async updatePersonaModel(
    workspaceId: string,
    personaId: string,
    model: string | null
  ): Promise<WorkspacePersonaSummary> {
    const base = getBuiltInAgentConfig(personaId)
    if (!base || base.visibility !== "visible") {
      throw new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })
    }

    if (model === null) {
      await AgentConfigOverrideRepository.removePatchKeys(this.pool, workspaceId, personaId, ["model"])
    } else {
      const capabilities = this.modelRegistry.getCapabilities(model)
      if (!capabilities || !isChatModel(capabilities)) {
        throw new HttpError(`Model "${model}" is not an assignable chat model`, {
          status: 400,
          code: "UNSUPPORTED_PERSONA_MODEL",
        })
      }
      // Validates the merged end state loudly before persisting (same gate the read path uses).
      applyBuiltInAgentPatch(base, { model }, { workspaceId, agentId: personaId })
      await AgentConfigOverrideRepository.mergePatch(this.pool, workspaceId, personaId, { model })
    }

    const override = await AgentConfigOverrideRepository.findActiveByWorkspaceAndAgent(
      this.pool,
      workspaceId,
      personaId
    )
    return this.buildSummary(base, override?.patch, workspaceId)
  }

  private buildSummary(base: BuiltInAgentConfig, patch: unknown, workspaceId: string): WorkspacePersonaSummary {
    const resolved = patch ? applyBuiltInAgentPatch(base, patch, { workspaceId, agentId: base.id }) : base
    const parsedPatch = patch ? builtInAgentConfigPatchSchema.safeParse(patch) : null
    const overriddenFields = parsedPatch?.success ? Object.keys(parsedPatch.data) : []

    return {
      id: base.id,
      slug: resolved.slug,
      name: resolved.name,
      description: resolved.description,
      avatarEmoji: resolved.avatarEmoji,
      model: resolved.model,
      defaultModel: base.model,
      status: resolved.status,
      overriddenFields,
    }
  }

  private listAssignableModels(): AvailablePersonaModel[] {
    return this.modelRegistry
      .getModelIds()
      .filter((id) => {
        const caps = this.modelRegistry.getCapabilities(id)
        return caps !== undefined && isChatModel(caps)
      })
      .map((id) => ({ id, name: this.modelRegistry.getCapabilities(id)!.name }))
  }
}

/** Text-in/text-out request-response models; excludes embeddings and realtime STT. */
function isChatModel(caps: { inputModalities: string[]; outputModalities: string[]; streaming?: string }): boolean {
  return caps.inputModalities.includes("text") && caps.outputModalities.includes("text") && caps.streaming === undefined
}
