import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { SETTINGS_TABS, type SettingsTab } from "@threa/types"

interface SettingsContextValue {
  isOpen: boolean
  activeTab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setActiveTab: (tab: SettingsTab) => void
  getSettingsUrl: (tab?: SettingsTab) => string
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

const DEFAULT_TAB: SettingsTab = "profile"

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()

  const settingsParam = searchParams.get("settings")
  const isOpen = settingsParam !== null
  const activeTab: SettingsTab =
    settingsParam && SETTINGS_TABS.includes(settingsParam as SettingsTab) ? (settingsParam as SettingsTab) : DEFAULT_TAB

  const openSettings = useCallback(
    (tab?: SettingsTab) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set("settings", tab || DEFAULT_TAB)
      setSearchParams(newParams, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const closeSettings = useCallback(() => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete("settings")
    setSearchParams(newParams, { replace: true })
  }, [searchParams, setSearchParams])

  const setActiveTab = useCallback(
    (tab: SettingsTab) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set("settings", tab)
      setSearchParams(newParams, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const getSettingsUrl = useCallback(
    (tab?: SettingsTab) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set("settings", tab || DEFAULT_TAB)
      return `?${newParams.toString()}`
    },
    [searchParams]
  )

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeTab,
      openSettings,
      closeSettings,
      setActiveTab,
      getSettingsUrl,
    }),
    [isOpen, activeTab, openSettings, closeSettings, setActiveTab, getSettingsUrl]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

/**
 * The settings context when there is one, `null` otherwise. For surfaces that
 * render both inside and outside the workspace shell (the timeline/board effect
 * lines) and degrade to a non-link rather than failing to render.
 */
export function useOptionalSettings(): SettingsContextValue | null {
  return useContext(SettingsContext)
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider")
  }
  return context
}
