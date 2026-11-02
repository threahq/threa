import { useEffect } from "react"
import { getActiveDb } from "@/db"
import { persistSqliteStorageMode, stopAndDestroySqliteShadow } from "@/db/sqlite-mirror/lifecycle"
import { useFeatureFlagWhenKnown } from "./use-feature-flags"

/**
 * Persists the workspace's `sqliteStorage` flag for the next boot, which is
 * when the mode takes effect. Turning it off also stops and deletes a running
 * mirror, the one change that is safe mid-session. Waits for the delivered
 * value: acting on the pre-bootstrap default would delete the mirror on every boot.
 */
export function useSqliteStorageFlag(workspaceId: string): void {
  const mode = useFeatureFlagWhenKnown(workspaceId, "sqliteStorage")
  useEffect(() => {
    if (mode === null) return
    persistSqliteStorageMode(mode)
    if (mode === "off") void stopAndDestroySqliteShadow(getActiveDb())
  }, [mode])
}
