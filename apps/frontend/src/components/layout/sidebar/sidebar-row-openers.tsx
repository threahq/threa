import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { useOutcomesUrlState } from "@/components/agent-outcomes"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { useStreamMembers } from "@/components/stream-settings/use-stream-members"
import { useStableCallback } from "@/hooks/use-stable-callback"

interface SidebarRowOpeners {
  openStreamSettings: ReturnType<typeof useStreamSettings>["openStreamSettings"]
  openStreamMembers: ReturnType<typeof useStreamMembers>["openStreamMembers"]
  openExplorer: ReturnType<typeof useExplorerUrlState>["open"]
  openOutcomes: ReturnType<typeof useOutcomesUrlState>["open"]
}

const SidebarRowOpenersContext = createContext<SidebarRowOpeners | null>(null)

/**
 * The URL-state surfaces a row's menu opens, read once for the whole list. Each
 * opener's hook subscribes to the location, so calling them per row re-rendered
 * every row on every navigation; here only this provider does, and the rows get
 * identity-stable handlers that write against the latest committed params.
 */
export function SidebarRowOpenersProvider({ children }: { children: ReactNode }) {
  const openStreamSettings = useStableCallback(useStreamSettings().openStreamSettings)
  const openStreamMembers = useStableCallback(useStreamMembers().openStreamMembers)
  const openExplorer = useStableCallback(useExplorerUrlState().open)
  const openOutcomes = useStableCallback(useOutcomesUrlState().open)
  const value = useMemo(
    () => ({ openStreamSettings, openStreamMembers, openExplorer, openOutcomes }),
    [openStreamSettings, openStreamMembers, openExplorer, openOutcomes]
  )
  return <SidebarRowOpenersContext.Provider value={value}>{children}</SidebarRowOpenersContext.Provider>
}

export function useSidebarRowOpeners(): SidebarRowOpeners {
  const openers = useContext(SidebarRowOpenersContext)
  if (!openers) throw new Error("useSidebarRowOpeners must be used within a SidebarRowOpenersProvider")
  return openers
}
