import { useContext, useMemo, useRef, type ReactNode } from "react"
import { parsePath, UNSAFE_NavigationContext, UNSAFE_RouteContext, type Navigator, type To } from "react-router-dom"
import { usePanel } from "@/contexts"

/**
 * Sends the links and navigations inside a pane through it, changing it in place or taking its tab; anything a
 * pane can't hold goes to the router. Off the data router's navigate, which would bypass the navigator.
 */
export function PaneNavigation({ children }: { children: ReactNode }) {
  const { navigateIn } = usePanel()
  const navigation = useContext(UNSAFE_NavigationContext)
  const route = useContext(UNSAFE_RouteContext)
  // Rebuilt with each layout change, the navigator would hand out a new `navigate` and re-run effects keyed on it.
  const navigateInRef = useRef(navigateIn)
  navigateInRef.current = navigateIn
  const paneNavigation = useMemo(() => {
    const outer = navigation.navigator
    const go =
      (replace: boolean): Navigator["push"] =>
      (to: To, state, options) => {
        const { pathname = "", search = "", hash } = typeof to === "string" ? parsePath(to) : to
        if (!hash && navigateInRef.current({ pathname, search }, replace)) return
        ;(replace ? outer.replace : outer.push)(to, state, options)
      }
    return { ...navigation, navigator: { ...outer, push: go(false), replace: go(true) } }
  }, [navigation])
  const paneRoute = useMemo(() => ({ ...route, isDataRoute: false }), [route])
  return (
    <UNSAFE_RouteContext.Provider value={paneRoute}>
      <UNSAFE_NavigationContext.Provider value={paneNavigation}>{children}</UNSAFE_NavigationContext.Provider>
    </UNSAFE_RouteContext.Provider>
  )
}
