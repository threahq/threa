import { useCallback, useEffect, useState } from "react"

export type SearchResultDisplayMode = "grouped" | "ranked"

function storageKey(workspaceId: string): string {
  return `threa-search-result-display:${workspaceId}`
}

export function readStoredSearchResultDisplayMode(workspaceId: string): SearchResultDisplayMode {
  try {
    return localStorage.getItem(storageKey(workspaceId)) === "ranked" ? "ranked" : "grouped"
  } catch {
    return "grouped"
  }
}

export function writeStoredSearchResultDisplayMode(workspaceId: string, mode: SearchResultDisplayMode): void {
  try {
    localStorage.setItem(storageKey(workspaceId), mode)
  } catch {
    // localStorage can throw (private mode, quota); the preference is best-effort
  }
}

export function useStoredSearchResultDisplayMode(
  workspaceId: string
): [SearchResultDisplayMode, (next: SearchResultDisplayMode) => void] {
  const [mode, setModeState] = useState<SearchResultDisplayMode>(() => readStoredSearchResultDisplayMode(workspaceId))
  useEffect(() => {
    setModeState(readStoredSearchResultDisplayMode(workspaceId))
  }, [workspaceId])
  const setMode = useCallback(
    (next: SearchResultDisplayMode) => {
      setModeState(next)
      writeStoredSearchResultDisplayMode(workspaceId, next)
    },
    [workspaceId]
  )
  return [mode, setMode]
}
