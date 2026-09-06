import type { ModelRegistry } from "@threahq/agent-runtime"
import type { UserPreferences, WorkspaceSettings } from "@threahq/types"
import { resolveSubagentModels } from "./models"
import { SubagentAlreadyActiveError } from "./repository"
import type { CreateSubagentParams, SubagentService } from "./service"

/**
 * What the `start_subagent` tool boundary returns. The two refusals are the
 * ones a model can act on: `already_active` means wait for or cancel the
 * running subagent, `model_not_allowed` carries the governed set so the next
 * attempt is a choice, not another guess.
 */
export type StartSubagentOutcome =
  | { ok: true; subagentId: string; threadStreamId: string; model: string }
  | { ok: false; reason: "already_active" }
  | { ok: false; reason: "model_not_allowed"; allowedModels: string[] }

/** What closing a run reports back. `already_closed` = the CAS lost (cancelled, expired, or replayed). */
export type ReportBackOutcome = { ok: true; subagentId: string } | { ok: false; reason: "already_closed" }

export interface SubagentDelegationDeps {
  subagentService: SubagentService
  modelRegistry: ModelRegistry
  loadWorkspaceSettings: (workspaceId: string) => Promise<Pick<WorkspaceSettings, "subagentModels">>
  /** The run's `createdBy` user — the authority the run is anchored to, so their subset is the one that binds. */
  loadUserPreferences: (params: {
    workspaceId: string
    userId: string
  }) => Promise<Pick<UserPreferences, "subagentModels">>
}

/**
 * The whole `start_subagent` execution: resolve the governed set, refuse an
 * off-policy model, then open the run. The allowlist is re-resolved HERE rather
 * than trusted from the description the turn was built with — the workspace's
 * set or the user's own subset may have moved since, and this is the boundary
 * the model actually crosses. One path, shared by the live tool binding and its
 * tests (INV-45).
 */
export async function startSubagent(
  deps: SubagentDelegationDeps,
  params: CreateSubagentParams
): Promise<StartSubagentOutcome> {
  const [workspaceSettings, userPreferences] = await Promise.all([
    deps.loadWorkspaceSettings(params.workspaceId),
    deps.loadUserPreferences({ workspaceId: params.workspaceId, userId: params.createdBy }),
  ])
  const allowedModels = resolveSubagentModels({
    workspaceSettings,
    userPreferences,
    modelRegistry: deps.modelRegistry,
  })
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
