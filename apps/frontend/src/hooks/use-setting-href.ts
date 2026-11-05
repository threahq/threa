import { useMemo } from "react"
import { useOptionalSettings } from "@/contexts/settings-context"
import { tabOfSetting, type SettingId } from "@/components/settings/settings-registry"
import type { SettingsTab } from "@threahq/types"

export type GetSettingsUrl = (tab?: SettingsTab, setting?: string) => string

/** The settings-window link that lands on one setting's row. */
export function settingHref(getSettingsUrl: GetSettingsUrl, setting: SettingId): string {
  return getSettingsUrl(tabOfSetting(setting) ?? undefined, setting)
}

/**
 * {@link settingHref} for a product surface, or null outside the workspace shell
 * (no settings window to open there). Subscribes to every search-param change,
 * so mount it in a small leaf or an open menu, never in every timeline row.
 */
export function useSettingHref(setting: SettingId): string | null {
  const settings = useOptionalSettings()
  return settings ? settingHref(settings.getSettingsUrl, setting) : null
}

/**
 * A menu context carrying the settings url, for menu content that renders only
 * while open: the row that owns the context never subscribes.
 */
export function useWithSettingsUrl<Context extends { getSettingsUrl?: GetSettingsUrl }>(context: Context): Context {
  const getSettingsUrl = useOptionalSettings()?.getSettingsUrl
  return useMemo(() => (getSettingsUrl ? { ...context, getSettingsUrl } : context), [context, getSettingsUrl])
}
