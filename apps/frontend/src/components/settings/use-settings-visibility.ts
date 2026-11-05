import { useMemo } from "react"
import { DEFAULT_SUBAGENT_MODELS, SETTINGS_TABS, WORKSPACE_PERMISSION_SCOPES, type SettingsTab } from "@threahq/types"
import { usePreferencesOptional } from "@/contexts"
import { useFeatureFlag } from "@/hooks"
import { useOverriddenFeatureFlags } from "@/hooks/use-feature-flags"
import { useCachedWorkspaceBootstrap, useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { SETTINGS_PAGE_CONFIG, type SettingId, type SettingsVisibility } from "./settings-registry"
import { subagentModelsState } from "./subagent-models-settings"

export interface ViewerSettingsVisibility extends SettingsVisibility {
  permissionsLoaded: boolean
  /** Admin-only pages while permissions load: the nav holds their place. */
  pendingTabs: readonly SettingsTab[]
  /** Workspace pages this viewer may open but not change. */
  viewOnly: ReadonlySet<SettingsTab>
}

/**
 * Which settings pages and rows this viewer gets. Admin-only pages (their
 * routes are admin-gated server-side) wait for permissions; diagnostics
 * follows its rollout; the Early access page shows only when a flag is
 * actually set for the viewer; subagent models only when the picker has
 * something to offer.
 */
export function useSettingsVisibility(workspaceId: string): ViewerSettingsVisibility {
  const permissions = useViewerPermissions(workspaceId)
  const isAdmin = hasPermission(permissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const perfDiagnostics = useFeatureFlag(workspaceId, "perfDiagnostics")
  const hasOverriddenFlags = useOverriddenFeatureFlags(workspaceId).length > 0
  const permissionsLoaded = permissions !== undefined
  const workspaceModels = useCachedWorkspaceBootstrap(
    workspaceId,
    (bootstrap) => bootstrap.workspaceSettings?.subagentModels
  )
  const storedModels = usePreferencesOptional()?.preferences?.subagentModels
  const subagentModelsAvailable = subagentModelsState(
    workspaceModels ?? DEFAULT_SUBAGENT_MODELS,
    storedModels ?? []
  ).available

  return useMemo(() => {
    const hidden = new Set<SettingId>()
    if (perfDiagnostics !== "available") hidden.add("diagnostics")
    if (!subagentModelsAvailable) hidden.add("subagent-models")
    const adminOnly = (tab: SettingsTab) => SETTINGS_PAGE_CONFIG[tab].admins === true
    const editableWith = (tab: SettingsTab) => SETTINGS_PAGE_CONFIG[tab].editableWith ?? []
    return {
      tabs: SETTINGS_TABS.filter(
        (tab) => (isAdmin || !adminOnly(tab)) && (tab !== "early-access" || hasOverriddenFlags)
      ),
      hidden,
      permissionsLoaded,
      pendingTabs: permissionsLoaded ? [] : SETTINGS_TABS.filter(adminOnly),
      viewOnly: new Set(
        permissionsLoaded
          ? SETTINGS_TABS.filter(
              (tab) =>
                editableWith(tab).length > 0 && !editableWith(tab).some((scope) => hasPermission(permissions, scope))
            )
          : []
      ),
    }
  }, [isAdmin, perfDiagnostics, hasOverriddenFlags, subagentModelsAvailable, permissionsLoaded, permissions])
}
