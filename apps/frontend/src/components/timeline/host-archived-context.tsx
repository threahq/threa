import { createContext, useContext } from "react"

/**
 * Whether the timeline being rendered is effectively archived (its own row or
 * any ancestor). Rows read it to grey their thread cards and drop write
 * affordances; `StreamContent` provides the verdict it already resolved through
 * `useEffectiveArchived`, so no row re-walks the parent chain.
 */
const HostArchivedContext = createContext(false)

export const HostArchivedProvider = HostArchivedContext.Provider

export function useHostArchived(): boolean {
  return useContext(HostArchivedContext)
}
