import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { withStreamSettings, type StreamSettingsTab } from "@/contexts/settings-context"
import { useSettingsLinkHistory } from "@/components/settings/settings-link-history"

/**
 * Opens a stream's pages in the settings window, a history entry like every
 * place in it. Without a tab, phones open on the window's index and desktop
 * on the stream's first page.
 */
export function useStreamSettings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const linkHistory = useSettingsLinkHistory()
  const openStreamSettings = useCallback(
    (sid: string | null, tab?: StreamSettingsTab, setting?: string) => {
      setSearchParams(withStreamSettings(searchParams, sid, tab, setting), linkHistory)
    },
    [searchParams, setSearchParams, linkHistory]
  )
  return { openStreamSettings }
}
