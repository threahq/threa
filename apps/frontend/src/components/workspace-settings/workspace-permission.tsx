import type { ReactNode } from "react"
import { WORKSPACE_PERMISSION_SCOPES, type WorkspacePermissionSlug } from "@threahq/types"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { settingDef, type SettingId } from "@/components/settings/settings-registry"
import {
  DisabledReason,
  SETTING_CONTROL_WIDTH,
  SettingControlSkeleton,
  SettingValue,
} from "@/components/settings/setting-primitives"

export interface WorkspaceAccess {
  /** False until the bootstrap lands. Unknown is not denied, so read-only reasons wait for it. */
  known: boolean
  allowed: boolean
}

export function useWorkspaceAccess(
  workspaceId: string,
  scope: WorkspacePermissionSlug = WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN
): WorkspaceAccess {
  const permissions = useViewerPermissions(workspaceId)
  return { known: permissions !== undefined, allowed: hasPermission(permissions, scope) }
}

const ADMIN_ONLY_REASON = "Only workspace admins can change this."

/**
 * A row's description, plus a line saying why the viewer can't change it when
 * they can't. `undefined` keeps the registry description untouched.
 */
export function accessDescription(
  setting: SettingId,
  access: WorkspaceAccess,
  { base, reason = ADMIN_ONLY_REASON }: { base?: ReactNode; reason?: string } = {}
): ReactNode | undefined {
  if (!access.known || access.allowed) return base
  const description = base ?? settingDef(setting).description
  return (
    <>
      {description}
      <DisabledReason>{reason}</DisabledReason>
    </>
  )
}

/**
 * A permission-gated control: the editable one when the viewer may change it,
 * `readOnly` as a {@link SettingValue} in the same footprint when they can't,
 * and a placeholder of that size until it's known.
 */
export function GatedControl({
  access,
  readOnly,
  skeletonClassName = SETTING_CONTROL_WIDTH,
  children,
}: {
  access: WorkspaceAccess
  /** The value itself, not a styled element: it renders as a `SettingValue`. */
  readOnly: ReactNode
  skeletonClassName?: string
  children: ReactNode
}) {
  if (!access.known) return <SettingControlSkeleton className={skeletonClassName} />
  if (access.allowed) return <>{children}</>
  return <SettingValue className={skeletonClassName}>{readOnly}</SettingValue>
}
