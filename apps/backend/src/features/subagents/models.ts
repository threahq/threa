import type { ModelRegistry } from "@threa/agent-runtime"
import type { WorkspaceSettings } from "@threa/types"

/**
 * The models a subagent may run on, in one place (INV-33). Two gates, in this
 * order and never separately: the model registry (`models.yaml`) decides what
 * exists and can be called at all, the workspace's `subagentModels` decides
 * what this workspace pays for. A registry entry that disappears therefore
 * stops being delegable without anyone editing workspace settings.
 *
 * The result is order-preserving on the workspace list — that list is what an
 * admin arranged, and PR D's picker renders it.
 */
export function resolveSubagentModels(params: {
  workspaceSettings: Pick<WorkspaceSettings, "subagentModels">
  modelRegistry: ModelRegistry
}): string[] {
  const { workspaceSettings, modelRegistry } = params
  return workspaceSettings.subagentModels.filter((model) => modelRegistry.isChatModel(model))
}

/** Whether one model id is delegable in this workspace right now. */
export function isSubagentModelAllowed(
  model: string,
  params: { workspaceSettings: Pick<WorkspaceSettings, "subagentModels">; modelRegistry: ModelRegistry }
): boolean {
  return resolveSubagentModels(params).includes(model)
}
