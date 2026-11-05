import { useParams } from "react-router-dom"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import { usePreferencesOptional } from "@/contexts"
import { useSettingHref } from "@/hooks/use-setting-href"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { SETTINGS, SETTINGS_PAGE_CONFIG, relatedSetting, tabOfSetting, type SettingId } from "./settings-registry"
import { isSettingChanged } from "./setting-defaults"
import { SETTING_NOTE_TEXT } from "./setting-text"
import { useSettingsVisibility } from "./use-settings-visibility"

/**
 * A dot beside a row's label while its value differs from the default. `changed`
 * decides it for rows whose default the defaults map doesn't own, such as one shortcut.
 */
export function SettingChangedMark({ setting, changed }: { setting: string; changed?: boolean }) {
  const differs = isSettingChanged(setting, usePreferencesOptional()?.preferences)
  if (!(changed ?? differs)) return null
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span className="sr-only">Changed from default</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Changed from default
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The link from a personal setting to the workspace setting it falls back to,
 * and back, or to the setting it depends on, when the viewer can see that page.
 */
export function SettingTwinLink({ setting }: { setting: string }) {
  const twin = relatedSetting(setting)
  return twin ? <TwinLink twin={twin} /> : null
}

function TwinLink({ twin }: { twin: SettingId }) {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>()
  const { tabs } = useSettingsVisibility(workspaceId)
  const href = useSettingHref(twin)
  const tab = tabOfSetting(twin)
  if (!href || !tab || !tabs.includes(tab)) return null
  const label = SETTINGS[twin].label
  return (
    <span className={cn("block text-muted-foreground", SETTING_NOTE_TEXT)}>
      <SettingsLink setting={twin}>{label}</SettingsLink> in {SETTINGS_PAGE_CONFIG[tab].label}
    </span>
  )
}
