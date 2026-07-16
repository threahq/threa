import { createContext, useContext } from "react"

/**
 * Close signal for the expanded composer's mobile FAB action drawer. The
 * drawer's contents (drafts/scheduled pickers) are passed into MessageComposer
 * as opaque slot nodes by each host, so the "your action finished — collapse
 * the drawer too" signal travels by context rather than props. Null outside
 * the drawer: the compact toolbar pickers render with the default and no-op.
 */
export const FabDrawerCloseContext = createContext<(() => void) | null>(null)

export function useFabDrawerClose(): (() => void) | null {
  return useContext(FabDrawerCloseContext)
}
