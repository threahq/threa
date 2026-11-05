import { useSyncExternalStore } from "react"
import { onStorageUpgrade, storageUpgrade, type StorageUpgradeProgress } from "@/db/sqlite-mirror/storage-mode"

/** How far the one-off copy into SQLite storage has come; `null` when no copy holds the app. */
export function useStorageUpgrade(): StorageUpgradeProgress | null {
  return useSyncExternalStore(onStorageUpgrade, storageUpgrade)
}
