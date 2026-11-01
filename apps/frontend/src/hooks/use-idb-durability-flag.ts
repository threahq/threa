import { useEffect } from "react"
import { setIdbRelaxedDurability } from "@/db/transaction-middleware"
import { useFeatureFlag } from "./use-feature-flags"

/** Pushes the workspace's `idbRelaxedDurability` flag into the IndexedDB transaction middleware. */
export function useIdbDurabilityFlag(workspaceId: string): void {
  const relaxed = useFeatureFlag(workspaceId, "idbRelaxedDurability") === "on"
  useEffect(() => {
    setIdbRelaxedDurability(relaxed)
  }, [relaxed])
}
