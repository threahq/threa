import type { ModelRegistry } from "@threa/agent-runtime"
import type { WorkspaceSettings } from "@threa/types"
import { resolveSubagentModels } from "./models"
import { SubagentAlreadyActiveError } from "./repository"
import type { CreateSubagentParams, SubagentService } from "./service"

/**
 * What the `delegate_to_model` tool boundary returns. The two refusals are the
 * ones a model can act on: `already_active` means wait for or cancel the
 * running subagent, `model_not_allowed` carries the governed set so the next
 * attempt is a choice, not another guess.
 */
export type DelegateToModelOutcome =
  | { ok: true; subagentId: string; threadStreamId: string; model: string }
  | { ok: false; reason: "already_active" }
  | { ok: false; reason: "model_not_allowed"; allowedModels: string[] }

/** What closing a run reports back. `already_closed` = the CAS lost (cancelled, expired, or replayed). */
export type ReportBackOutcome = { ok: true; subagentId: string } | { ok: false; reason: "already_closed" }

export interface SubagentDelegationDeps {
  subagentService: SubagentService
  modelRegistry: ModelRegistry
  loadWorkspaceSettings: (workspaceId: string) => Promise<Pick<WorkspaceSettings, "subagentModels">>
}

/**
 * The whole `delegate_to_model` execution: resolve the governed set, refuse an
 * off-policy model, then open the run. The allowlist is re-resolved HERE rather
 * than trusted from the description the turn was built with — the workspace's
 * set may have moved since, and this is the boundary the model actually
 * crosses. One path, shared by the live tool binding and its tests (INV-45).
 */
export async function delegateToSubagent(
  deps: SubagentDelegationDeps,
  params: CreateSubagentParams
): Promise<DelegateToModelOutcome> {
  const workspaceSettings = await deps.loadWorkspaceSettings(params.workspaceId)
  const allowedModels = resolveSubagentModels({ workspaceSettings, modelRegistry: deps.modelRegistry })
  if (!allowedModels.includes(params.model)) {
    return { ok: false, reason: "model_not_allowed", allowedModels }
  }

  try {
    const { run, threadStreamId } = await deps.subagentService.create(params)
    return { ok: true, subagentId: run.id, threadStreamId, model: run.model }
  } catch (error) {
    if (error instanceof SubagentAlreadyActiveError) return { ok: false, reason: "already_active" }
    throw error
  }
}
