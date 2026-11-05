import { useMemo } from "react"
import { Hash } from "lucide-react"
import type { SettingsTab } from "@threahq/types"
import { usePreferencesOptional } from "@/contexts"
import { SETTINGS_PAGE_CONFIG, searchSettings, settingResultTrail } from "@/components/settings/settings-registry"
import { useSettingsSummaries } from "@/components/settings/use-settings-summaries"
import { useSettingsVisibility } from "@/components/settings/use-settings-visibility"
import { useAnyStreamSettingsTabs, useStreamSettingsScope } from "@/components/settings/use-stream-settings-scope"
import type { StreamSettingsTab } from "@/contexts/settings-context"
import type { QuickSwitcherItem } from "./types"

interface UseSettingItemsParams {
  workspaceId: string
  query: string
  /** The stream in view, whose own settings join the results. */
  currentStreamId: string | null | undefined
  limit: number
  closeDialog: () => void
  openSettings: (tab: SettingsTab, setting: string) => void
  /** Without a stream the window asks which one. */
  openStreamSettings: (streamId: string | null, tab: StreamSettingsTab, setting: string) => void
}

/**
 * Individual settings as palette rows, from the same index as the settings
 * window's search. Pages and rows this viewer can't see (admin-only,
 * rollout-gated) stay out rather than opening the window on a fallback.
 * Stream settings show with no stream in view too, and ask for one.
 */
export function useSettingItems({
  workspaceId,
  query,
  currentStreamId,
  limit,
  closeDialog,
  openSettings,
  openStreamSettings,
}: UseSettingItemsParams): QuickSwitcherItem[] {
  const visibility = useSettingsVisibility(workspaceId)
  const stream = useStreamSettingsScope(workspaceId, currentStreamId)
  const anyStreamTabs = useAnyStreamSettingsTabs(workspaceId)
  const { values } = useSettingsSummaries(workspaceId, stream)
  const shortcutBindings = usePreferencesOptional()?.preferences?.keyboardShortcuts

  return useMemo(() => {
    if (limit <= 0) return []
    return searchSettings(query, visibility, { shortcutBindings, stream: stream ?? undefined, anyStreamTabs })
      .filter((result) => !result.related)
      .slice(0, limit)
      .map((result): QuickSwitcherItem => {
        const { target } = result
        return {
          id: `setting-${result.id}`,
          label: result.label,
          description: [values[result.id as keyof typeof values], settingResultTrail(result)]
            .filter(Boolean)
            .join(" · "),
          icon: target.kind === "settings" ? SETTINGS_PAGE_CONFIG[target.tab].icon : Hash,
          group: "Settings",
          onSelect: () => {
            closeDialog()
            if (target.kind === "settings") openSettings(target.tab, target.anchor)
            else openStreamSettings(result.needsStream ? null : (stream?.streamId ?? null), target.tab, target.anchor)
          },
        }
      })
  }, [
    query,
    visibility,
    shortcutBindings,
    stream,
    anyStreamTabs,
    values,
    limit,
    closeDialog,
    openSettings,
    openStreamSettings,
  ])
}
