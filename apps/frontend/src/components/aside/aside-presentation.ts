import { createContext } from "react"
import { useIsSplitCapable } from "@/hooks/use-mobile"
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"

/**
 * Whether the aside shows as a sheet over the page rather than beside what it
 * answers: on a phone or coarse pointer, and in a window too narrow for a split
 * at all. One predicate, read by every surface that lays the aside out: two
 * derivations drift, and the drift mounts the aside twice.
 */
export function useAsideIsSheet(): boolean {
  const coarse = useIsMobileOrCoarse()
  const splitCapable = useIsSplitCapable()
  return coarse || !splitCapable
}

/** Whether an open aside stands over this page's panes, so a pane opened from under it would land out of sight. */
export const AsideCoversPanesContext = createContext(false)
