import type { ModelRegistry } from "@threa/agent-runtime"
import type { UserPreferences, WorkspaceSettings } from "@threa/types"

/**
 * The models a subagent may run on, in one place (INV-33). Three gates, in this
 * order and never separately: the model registry (`models.yaml`) decides what
 * exists and can be called at all, the workspace's `subagentModels` decides
 * what this workspace pays for, and the user's own `subagentModels` narrows
 * that further. A registry entry that disappears therefore stops being
 * delegable without anyone editing workspace settings.
 *
 * The user layer is a SUBSET, never an extension: an empty user list means "no
 * personal narrowing" and yields the workspace set, and a non-empty one is
 * intersected — so a user can decline a model the workspace pays for but can
 * never delegate to one it withheld. An intersection that comes out empty is
 * empty: the tool is then not offered at all, which is the honest reading of "I
 * only allow models my workspace doesn't".
 *
 * The result is order-preserving on the workspace list — that list is what an
 * admin arranged, and the picker renders it.
 */
export function resolveSubagentModels(params: {
  workspaceSettings: Pick<WorkspaceSettings, "subagentModels">
  userPreferences?: Pick<UserPreferences, "subagentModels"> | null
  modelRegistry: ModelRegistry
}): string[] {
  const { workspaceSettings, userPreferences, modelRegistry } = params
  const governed = workspaceSettings.subagentModels.filter((model) => modelRegistry.isChatModel(model))
  const userSubset = userPreferences?.subagentModels ?? []
  if (userSubset.length === 0) return governed
  return governed.filter((model) => userSubset.includes(model))
}
