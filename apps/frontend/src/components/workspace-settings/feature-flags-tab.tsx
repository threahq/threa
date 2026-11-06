import { FEATURE_FLAG_COPY, FEATURE_FLAG_VALUE_LABELS } from "@threahq/types"
import { SettingBadge, SettingEmptyNote, SETTING_ITEM_DIVIDERS } from "@/components/settings/setting-primitives"
import { SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import { useOverriddenFeatureFlags } from "@/hooks/use-feature-flags"

interface FeatureFlagsTabProps {
  workspaceId: string
}

/**
 * Read-only view of the viewer's feature flags that differ from the default.
 * Flags at their default value are intentionally not listed, and the tab
 * itself is hidden by the dialog when this list is empty — flag state never
 * leaks beyond what is actually enabled for the viewer.
 */
export function FeatureFlagsTab({ workspaceId }: FeatureFlagsTabProps) {
  const flags = useOverriddenFeatureFlags(workspaceId)

  if (flags.length === 0) return <SettingEmptyNote>No early features are on for you.</SettingEmptyNote>

  return (
    <ul className={SETTING_ITEM_DIVIDERS}>
      {flags.map(({ key, value, defaultValue, scope }) => (
        <li key={key} className="flex min-h-11 items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{FEATURE_FLAG_COPY[key].label}</p>
            <p className={cn("mt-0.5 text-muted-foreground", SETTING_NOTE_TEXT)}>
              {FEATURE_FLAG_COPY[key].description}
            </p>
            <p className={cn("mt-0.5 text-muted-foreground", SETTING_NOTE_TEXT)}>
              {scope === "user" ? "Rolling out to you" : "Rolling out to this workspace"} · normally{" "}
              {FEATURE_FLAG_VALUE_LABELS[defaultValue].toLowerCase()}
            </p>
          </div>
          <SettingBadge>{FEATURE_FLAG_VALUE_LABELS[value]}</SettingBadge>
        </li>
      ))}
    </ul>
  )
}
