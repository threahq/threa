import { useSyncExternalStore } from "react"
import {
  dismissStorageRestart,
  isStorageRestartPending,
  onStorageRestartPending,
  onStorageUpgrade,
  reloadEveryTab,
  storageUpgrade,
  type StorageUpgradeProgress,
} from "@/db/sqlite-mirror/storage-mode"

/** Whether storage waits for a restart of every tab to switch mode, and the user's two answers to it. */
export function useStorageRestart(): { pending: boolean; restart: () => void; dismiss: () => void } {
  const pending = useSyncExternalStore(onStorageRestartPending, isStorageRestartPending)
  return { pending, restart: reloadEveryTab, dismiss: dismissStorageRestart }
}

/** How far the one-off copy into SQLite storage has come; `null` when no upgrade holds the app. */
export function useStorageUpgrade(): StorageUpgradeProgress | null {
  return useSyncExternalStore(onStorageUpgrade, storageUpgrade)
}
