import { useEffect } from "react"
import { persistSqliteStorageMode, readSqliteStorageMode } from "@/db/sqlite-mirror/lifecycle"
import { reloadEveryTab } from "@/db/sqlite-mirror/storage-mode"
import { useDeliveredFeatureFlag } from "./use-feature-flags"

/**
 * Persists the user's `sqliteStorage` flag and reloads every tab, so each
 * boots again and the first able to hold the others out switches the
 * database's mode. Acts only on a value the server delivered this session that
 * differs from the persisted one: a stale copy would reload every tab twice.
 */
export function useSqliteStorageFlag(workspaceId: string): void {
  const mode = useDeliveredFeatureFlag(workspaceId, "sqliteStorage")
  useEffect(() => {
    if (mode === null || mode === readSqliteStorageMode()) return
    persistSqliteStorageMode(mode)
    reloadEveryTab()
  }, [mode])
}
