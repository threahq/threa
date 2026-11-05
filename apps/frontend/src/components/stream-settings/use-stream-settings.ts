import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { settingsWindowOpen, withStreamSettings, type StreamSettingsTab } from "@/contexts/settings-context"

/**
 * Opens a stream's pages in the settings window. Opening pushes, so Back
 * closes the window; from inside it, it replaces. Without a tab, phones open
 * on the window's index and desktop on the stream's first page.
 */
export function useStreamSettings() {
  const [searchParams, setSearchParams] = useSearchParams()
  const openStreamSettings = useCallback(
    (sid: string | null, tab?: StreamSettingsTab, setting?: string) => {
      setSearchParams(withStreamSettings(searchParams, sid, tab, setting), {
        replace: settingsWindowOpen(searchParams),
      })
    },
    [searchParams, setSearchParams]
  )
  return { openStreamSettings }
}
