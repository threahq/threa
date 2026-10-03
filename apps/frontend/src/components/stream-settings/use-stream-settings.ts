import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"

const PARAM_TAB = "stream-settings"
const PARAM_SID = "sid"

export const STREAM_SETTINGS_TABS = ["general", "companion", "members", "connect"] as const
export type StreamSettingsTab = (typeof STREAM_SETTINGS_TABS)[number]

export function useStreamSettings() {
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get(PARAM_TAB)
  const streamId = searchParams.get(PARAM_SID)
  const isOpen = tabParam !== null && streamId !== null

  const activeTab: StreamSettingsTab =
    tabParam && STREAM_SETTINGS_TABS.includes(tabParam as StreamSettingsTab)
      ? (tabParam as StreamSettingsTab)
      : "general"

  const openStreamSettings = useCallback(
    (sid: string, tab: StreamSettingsTab = "general") => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set(PARAM_TAB, tab)
      newParams.set(PARAM_SID, sid)
      setSearchParams(newParams, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const closeStreamSettings = useCallback(() => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete(PARAM_TAB)
    newParams.delete(PARAM_SID)
    setSearchParams(newParams, { replace: true })
  }, [searchParams, setSearchParams])

  const setTab = useCallback(
    (tab: string) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set(PARAM_TAB, tab)
      setSearchParams(newParams, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  return { isOpen, activeTab, streamId, openStreamSettings, closeStreamSettings, setTab }
}
