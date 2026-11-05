import { cn } from "@/lib/utils"
import { WORKSPACE_NAME_MAX_LENGTH } from "@threahq/types"
import { useWorkspaceFromStore } from "@/stores/workspace-store"
import { useRenameWorkspace } from "@/hooks/use-workspaces"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { formatRegion } from "@/lib/regions"
import { Input } from "@/components/ui/input"
import {
  SETTING_CONTROL_HEIGHT,
  SETTING_CONTROL_WIDTH,
  SettingRow,
  SettingValue,
  SettingsSection,
  settingIds,
  SaveError,
  SaveIndicator,
} from "@/components/settings/setting-primitives"
import { useCommittedText } from "@/components/settings/committed-field"
import { BillingTimezoneSection } from "./billing-timezone-section"
import { GatedControl, accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface GeneralTabProps {
  workspaceId: string
}

export function GeneralTab({ workspaceId }: GeneralTabProps) {
  const { formatDate } = useFormattedDate()
  const workspace = useWorkspaceFromStore(workspaceId)
  const access = useWorkspaceAccess(workspaceId)
  const name = workspace?.name ?? ""

  return (
    <SettingsSection section="workspace-identity">
      <SettingRow
        setting="workspace-name"
        labelFor={access.allowed}
        description={accessDescription("workspace-name", access, { reason: "Only admins can rename the workspace." })}
        control={
          <GatedControl access={access} readOnly={name}>
            <WorkspaceNameField workspaceId={workspaceId} name={name} disabled={!workspace} />
          </GatedControl>
        }
      />
      <SettingRow
        setting="workspace-region"
        labelFor={false}
        control={
          <SettingValue placeholder="Not assigned" className={SETTING_CONTROL_WIDTH}>
            {workspace?.region ? formatRegion(workspace.region) : null}
          </SettingValue>
        }
      />
      <BillingTimezoneSection workspaceId={workspaceId} />
      <SettingRow
        setting="workspace-created"
        labelFor={false}
        control={
          <SettingValue placeholder="—" className={SETTING_CONTROL_WIDTH}>
            {workspace?.createdAt ? formatDate(new Date(workspace.createdAt)) : null}
          </SettingValue>
        }
      />
    </SettingsSection>
  )
}

function WorkspaceNameField({ workspaceId, name, disabled }: { workspaceId: string; name: string; disabled: boolean }) {
  const ids = settingIds("workspace-name")
  const errorId = `${ids.control}-error`
  const rename = useRenameWorkspace(workspaceId)
  const field = useCommittedText<HTMLInputElement>({
    saved: name,
    required: true,
    failureMessage: "Couldn't rename the workspace",
    commit: (draft) => rename.mutateAsync(draft),
  })

  return (
    <div className={cn("space-y-1.5", SETTING_CONTROL_WIDTH)}>
      <div className="relative">
        <Input
          ref={field.fieldRef}
          id={ids.control}
          value={field.value}
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          autoComplete="off"
          enterKeyHint="done"
          disabled={disabled}
          required
          aria-invalid={field.state.kind === "error" || undefined}
          aria-errormessage={field.state.kind === "error" ? errorId : undefined}
          onChange={(event) => field.onChange(event.target.value)}
          onBlur={() => void field.save()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            void field.save()
          }}
          className={cn("w-full pr-9", SETTING_CONTROL_HEIGHT)}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
          <SaveIndicator state={field.state} />
        </span>
      </div>
      <SaveError state={field.state} id={errorId} />
    </div>
  )
}
