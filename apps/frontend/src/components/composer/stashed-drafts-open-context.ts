import { createContext, useContext, useEffect, type MutableRefObject } from "react"

/**
 * Open signal from MessageComposer to the stashed-drafts picker it hosts.
 * Cmd/Ctrl+S on an EMPTY composer opens the drafts popover (there is nothing
 * to stash, so the shortcut flips to "show me my drafts"); the picker is a
 * host-passed slot node, so — like FabDrawerCloseContext — the signal
 * travels by context. The picker registers its `open` into the ref; the
 * composer's stash key handler calls it. Null outside a composer that wires
 * the shortcut.
 */
export const StashedDraftsOpenContext = createContext<MutableRefObject<(() => void) | null> | null>(null)

export function useRegisterStashedDraftsOpen(open: () => void) {
  const ref = useContext(StashedDraftsOpenContext)
  useEffect(() => {
    if (!ref) return
    ref.current = open
    return () => {
      if (ref.current === open) ref.current = null
    }
  }, [ref, open])
}
