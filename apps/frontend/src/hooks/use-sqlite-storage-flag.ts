import { useEffect } from "react"
import { getActiveDb } from "@/db"
import { adoptDeliveredMode } from "@/db/sqlite-mirror/lifecycle"
import { requestStorageRestart } from "@/db/sqlite-mirror/storage-mode"
import { useDeliveredFeatureFlag } from "./use-feature-flags"

/**
 * Takes the user's `sqliteStorage` flag as the server delivered it this
 * session, never a stale copy. A change to the database's requested mode takes
 * effect at the first boot able to hold every other tab out, so the user is
 * asked to restart; nothing reloads on its own.
 */
export function useSqliteStorageFlag(workspaceId: string): void {
  const mode = useDeliveredFeatureFlag(workspaceId, "sqliteStorage")
  useEffect(() => {
    if (mode !== null && adoptDeliveredMode(getActiveDb().name, workspaceId, mode)) {
      requestStorageRestart(getActiveDb().name)
    }
  }, [mode, workspaceId])
}
