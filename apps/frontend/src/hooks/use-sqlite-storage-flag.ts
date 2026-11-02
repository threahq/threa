import { useEffect } from "react"
import { getActiveDb } from "@/db"
import { adoptDeliveredMode } from "@/db/sqlite-mirror/lifecycle"
import { reloadEveryTab } from "@/db/sqlite-mirror/storage-mode"
import { useDeliveredFeatureFlag } from "./use-feature-flags"

/**
 * Takes the user's `sqliteStorage` flag as the server delivered it this
 * session, never a stale copy, and reloads every tab when it changes the
 * database's requested mode, so the first boot able to hold the others out
 * switches it.
 */
export function useSqliteStorageFlag(workspaceId: string): void {
  const mode = useDeliveredFeatureFlag(workspaceId, "sqliteStorage")
  useEffect(() => {
    if (mode !== null && adoptDeliveredMode(getActiveDb().name, workspaceId, mode)) reloadEveryTab()
  }, [mode, workspaceId])
}
