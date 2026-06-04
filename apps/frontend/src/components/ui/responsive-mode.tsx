import * as React from "react"
import { useIsMobile } from "@/hooks/use-mobile"

// Carries the mobile/desktop decision the responsive root committed to, so the
// root and its content/sub-parts can never disagree mid-resize.
//
// Why this exists: ResponsiveDialog / ResponsiveAlertDialog render different
// roots per breakpoint (vaul <Drawer> on mobile, radix <Dialog>/<AlertDialog> on
// desktop). When the root and its content each called `useIsMobile()`
// independently, a viewport change crossing the breakpoint could leave them
// briefly out of sync — e.g. a <Drawer> root wrapping an <AlertDialogContent>.
// radix's AlertDialog portal is a *scoped* DialogPortal and vaul only provides
// the *unscoped* Dialog context, so that orphan throws
// "`DialogPortal` must be used within `Dialog`". Funnelling the decision through
// one context makes the content follow the root's committed mode.
const ResponsiveModeContext = React.createContext<boolean | null>(null)

export function ResponsiveModeProvider({ isMobile, children }: { isMobile: boolean; children: React.ReactNode }) {
  return <ResponsiveModeContext.Provider value={isMobile}>{children}</ResponsiveModeContext.Provider>
}

/**
 * Read the responsive mode chosen by the enclosing responsive root. Falls back
 * to the live media query only when a sub-part is rendered outside a root (so
 * standalone usage still works).
 */
export function useResponsiveMode(): boolean {
  const fromRoot = React.useContext(ResponsiveModeContext)
  const live = useIsMobile()
  return fromRoot ?? live
}
