import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useCoverClose } from "@/hooks/use-cover-close"
import { SETTINGS_COVER } from "@/lib/covers"
import { LEGACY_SETTINGS_TABS, SETTINGS_TABS, type SettingsTab } from "@threahq/types"

export const SETTINGS_PARAM = "settings"
/** The setting a link lands on: scrolled to and highlighted on its page. */
const SETTING_PARAM = "setting"
/** Selects a bot on the bots page, so a link can open its detail. */
export const SETTINGS_BOT_PARAM = "bot"
/** The workspace settings dialog's param, before the one settings window. */
const LEGACY_WORKSPACE_SETTINGS_PARAM = "ws-settings"
/** Rode on the integration install callback's `?ws-settings=` redirect; nothing reads it. */
const LEGACY_PROVIDER_PARAM = "provider"
/** A stream's page in the settings window; empty for the window's index. */
export const STREAM_SETTINGS_PARAM = "stream-settings"
/** The stream whose pages the window shows beside yours and the workspace's. */
export const STREAM_SETTINGS_SID_PARAM = "sid"
/** The overview's scope: phones show one scope at a time, desktop scrolls to it. */
const SETTINGS_SCOPE_PARAM = "scope"

/** Marks the sidebar's settings link: where focus goes when the window closes and its opener is gone. */
export const SETTINGS_ENTRY_ATTRIBUTE = "data-settings-entry"

const SETTINGS_SCOPES = ["stream", "you", "workspace"] as const
export type SettingsScope = (typeof SETTINGS_SCOPES)[number]

export const STREAM_SETTINGS_TABS = ["general", "companion", "members", "connect"] as const
export type StreamSettingsTab = (typeof STREAM_SETTINGS_TABS)[number]

/** Every param the window owns; closing takes them all off. */
const SETTINGS_WINDOW_COVER = [
  ...SETTINGS_COVER,
  STREAM_SETTINGS_PARAM,
  STREAM_SETTINGS_SID_PARAM,
  SETTINGS_SCOPE_PARAM,
] as const

/**
 * The URL's params without the settings window's, so a restored location
 * opens the page, never the window over it.
 */
export function withoutSettingsWindow(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const param of [...SETTINGS_WINDOW_COVER, LEGACY_WORKSPACE_SETTINGS_PARAM]) next.delete(param)
  return next
}

/**
 * History state of a page pushed over the phone index, so Back returns to the
 * index. Pages reached any other way replace, and Back closes the window.
 */
export const SETTINGS_DRILL_STATE = { settingsDrill: true } as const

interface SettingsContextValue {
  isOpen: boolean
  /** The open page, or null for the overview. */
  activeTab: SettingsTab | null
  /** The open stream page; null on any other page. */
  activeStreamTab: StreamSettingsTab | null
  /** `?stream-settings=` with no page: phones show the index, desktop the stream's first page. */
  streamIndex: boolean
  /** The stream a link opened the window on; its pages join the window's nav. */
  streamId: string | null
  /** The overview scope a link named; null leaves the default. */
  overviewScope: SettingsScope | null
  /** Opens the overview on one scope, as `openSettings` opens a page. */
  openOverview: (scope: SettingsScope) => void
  /** The setting to land on, when a link named one. */
  activeSetting: string | null
  /** New on every navigation, so following a link to the setting already named is a new request to land on it. */
  landingKey: string
  /** Opens a page, the overview without one; `setting` lands on one row. */
  openSettings: (tab?: SettingsTab, setting?: string) => void
  closeSettings: () => void
  setActiveTab: (tab: SettingsTab | null, setting?: string) => void
  getSettingsUrl: (tab?: SettingsTab, setting?: string) => string
  /** The open page was pushed over the phone index (`SETTINGS_DRILL_STATE`). */
  drilled: boolean
  /** Back to the index: pops a drilled page, replaces otherwise. */
  returnToIndex: () => void
  /**
   * A stream's page in this window, its first page without one; `setting`
   * lands on one row. Without a stream the window asks which one.
   */
  getStreamSettingsUrl: (streamId: string | null, tab?: StreamSettingsTab, setting?: string) => string
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (SETTINGS_TABS as readonly string[]).includes(value)
}

function isSettingsScope(value: string | null): value is SettingsScope {
  return value !== null && (SETTINGS_SCOPES as readonly string[]).includes(value)
}

function isStreamSettingsTab(value: string | null): value is StreamSettingsTab {
  return value !== null && (STREAM_SETTINGS_TABS as readonly string[]).includes(value)
}

/** Whether a URL's params open the settings window. */
export function settingsWindowOpen(params: URLSearchParams): boolean {
  return (
    params.get(SETTINGS_PARAM) !== null ||
    (params.get(STREAM_SETTINGS_PARAM) !== null &&
      (params.get(STREAM_SETTINGS_SID_PARAM) !== null || isStreamSettingsTab(params.get(STREAM_SETTINGS_PARAM))))
  )
}

/** Keeps `sid`, so the stream's pages stay in the nav while yours are shown. */
function withSettings(params: URLSearchParams, tab?: SettingsTab | null, setting?: string): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set(SETTINGS_PARAM, tab ?? "")
  next.delete(STREAM_SETTINGS_PARAM)
  next.delete(SETTINGS_SCOPE_PARAM)
  if (setting) next.set(SETTING_PARAM, setting)
  else next.delete(SETTING_PARAM)
  next.delete(SETTINGS_BOT_PARAM)
  return next
}

export function withStreamSettings(
  params: URLSearchParams,
  streamId: string | null,
  tab?: StreamSettingsTab | null,
  setting?: string
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete(SETTINGS_PARAM)
  next.delete(SETTINGS_BOT_PARAM)
  next.delete(SETTINGS_SCOPE_PARAM)
  next.set(STREAM_SETTINGS_PARAM, tab ?? "")
  if (streamId) next.set(STREAM_SETTINGS_SID_PARAM, streamId)
  else next.delete(STREAM_SETTINGS_SID_PARAM)
  if (setting) next.set(SETTING_PARAM, setting)
  else next.delete(SETTING_PARAM)
  return next
}

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()

  const settingsParam = searchParams.get(SETTINGS_PARAM)
  const streamParam = searchParams.get(STREAM_SETTINGS_PARAM)
  const streamId = searchParams.get(STREAM_SETTINGS_SID_PARAM)
  const activeTab = isSettingsTab(settingsParam) ? settingsParam : null
  const onStreamPage = settingsParam === null && streamParam !== null
  const activeStreamTab = onStreamPage && isStreamSettingsTab(streamParam) ? streamParam : null
  const streamIndex = onStreamPage && streamId !== null && activeStreamTab === null
  const scopeParam = searchParams.get(SETTINGS_SCOPE_PARAM)
  const overviewScope = settingsParam === "" && isSettingsScope(scopeParam) ? scopeParam : null
  const activeSetting = searchParams.get(SETTING_PARAM)
  const drilled =
    (activeTab !== null || activeStreamTab !== null) &&
    (location.state as Partial<typeof SETTINGS_DRILL_STATE> | null)?.settingsDrill === true
  // Closing a drilled page pops to the index first, then closes from there;
  // the window reads as closed from the first step.
  const [closing, setClosing] = useState(false)
  const stillOpen = settingsWindowOpen(searchParams)
  const isOpen = stillOpen && !closing

  // Bookmarks and restored launches from before the one settings window still
  // carry `?ws-settings=<tab>` or a retired `?settings=<tab>`; land them on the
  // page that tab became.
  const legacyWorkspaceTab = searchParams.get(LEGACY_WORKSPACE_SETTINGS_PARAM)
  const legacyPersonalTab =
    settingsParam !== null && Object.hasOwn(LEGACY_SETTINGS_TABS.settings, settingsParam) ? settingsParam : null
  useEffect(() => {
    const [legacy, tab]: [Record<string, SettingsTab>, string | null] =
      legacyWorkspaceTab !== null
        ? [LEGACY_SETTINGS_TABS["workspace-settings"], legacyWorkspaceTab]
        : [LEGACY_SETTINGS_TABS.settings, legacyPersonalTab]
    if (tab === null) return
    const next = withSettings(searchParams, Object.hasOwn(legacy, tab) ? legacy[tab] : null)
    next.delete(LEGACY_WORKSPACE_SETTINGS_PARAM)
    next.delete(LEGACY_PROVIDER_PARAM)
    const bot = searchParams.get(SETTINGS_BOT_PARAM)
    if (bot) next.set(SETTINGS_BOT_PARAM, bot)
    setSearchParams(next, { replace: true })
  }, [legacyWorkspaceTab, legacyPersonalTab, searchParams, setSearchParams])

  // Opening pushes so back closes the window; moving within it replaces, and
  // a drilled page stays drilled.
  const openWindowAt = useCallback(
    (next: URLSearchParams) => setSearchParams(next, { replace: isOpen, state: isOpen ? location.state : undefined }),
    [isOpen, location.state, setSearchParams]
  )

  const openSettings = useCallback(
    (tab?: SettingsTab, setting?: string) => openWindowAt(withSettings(searchParams, tab, setting)),
    [openWindowAt, searchParams]
  )

  // Keeps `sid`, so a stream's scope stays offered.
  const openOverview = useCallback(
    (scope: SettingsScope) => {
      const next = withSettings(searchParams, null)
      next.set(SETTINGS_SCOPE_PARAM, scope)
      openWindowAt(next)
    },
    [openWindowAt, searchParams]
  )

  const closeCover = useCoverClose(SETTINGS_WINDOW_COVER)
  const closeSettings = useCallback(() => {
    if (!drilled) return closeCover()
    setClosing(true)
    navigate(-1)
  }, [drilled, closeCover, navigate])
  useEffect(() => {
    if (!closing || drilled) return
    if (stillOpen) closeCover()
    else setClosing(false)
  }, [closing, drilled, stillOpen, closeCover])

  const setActiveTab = useCallback(
    (tab: SettingsTab | null, setting?: string) => {
      setSearchParams(withSettings(searchParams, tab, setting), { replace: true, state: location.state })
    },
    [location.state, searchParams, setSearchParams]
  )

  const returnToIndex = useCallback(() => {
    if (drilled) navigate(-1)
    else setSearchParams(withSettings(searchParams, null), { replace: true })
  }, [drilled, navigate, searchParams, setSearchParams])

  const getStreamSettingsUrl = useCallback(
    (sid: string | null, tab?: StreamSettingsTab, setting?: string) =>
      `?${withStreamSettings(searchParams, sid, tab, setting).toString()}`,
    [searchParams]
  )

  const getSettingsUrl = useCallback(
    (tab?: SettingsTab, setting?: string) => `?${withSettings(searchParams, tab, setting).toString()}`,
    [searchParams]
  )

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeTab,
      activeStreamTab,
      streamIndex,
      streamId,
      overviewScope,
      openOverview,
      activeSetting,
      landingKey: location.key,
      openSettings,
      closeSettings,
      setActiveTab,
      getSettingsUrl,
      drilled,
      returnToIndex,
      getStreamSettingsUrl,
    }),
    [
      isOpen,
      activeTab,
      activeStreamTab,
      streamIndex,
      streamId,
      overviewScope,
      openOverview,
      activeSetting,
      location.key,
      openSettings,
      closeSettings,
      setActiveTab,
      getSettingsUrl,
      drilled,
      returnToIndex,
      getStreamSettingsUrl,
    ]
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
