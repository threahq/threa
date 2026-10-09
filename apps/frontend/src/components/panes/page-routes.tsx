import { lazy, Suspense, useContext, useMemo, useRef, type ComponentType } from "react"
import {
  parsePath,
  Route,
  Routes,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  type Navigator,
  type To,
} from "react-router-dom"
import { usePanel, useRevealReady } from "@/contexts"
import type { PagePanePattern } from "@/lib/page-panes"

interface PageRoute {
  page: ComponentType
  /** Reports its own reveal readiness, rather than being ready once it renders. */
  reportsReady?: true
}

const PAGES: Record<PagePanePattern, PageRoute> = {
  "/drafts": { page: lazy(() => import("@/pages/drafts").then((m) => ({ default: m.DraftsPage }))) },
  "/saved/:tab?": { page: lazy(() => import("@/pages/saved").then((m) => ({ default: m.SavedPage }))) },
  "/streams/:tab?": { page: lazy(() => import("@/pages/streams").then((m) => ({ default: m.StreamsPage }))) },
  "/scheduled/:tab?": { page: lazy(() => import("@/pages/scheduled").then((m) => ({ default: m.ScheduledPage }))) },
  "/board": {
    page: lazy(() => import("@/pages/board").then((m) => ({ default: m.BoardPage }))),
    reportsReady: true,
  },
  "/activity/:filter?": { page: lazy(() => import("@/pages/activity").then((m) => ({ default: m.ActivityPage }))) },
  "/search": { page: lazy(() => import("@/pages/search").then((m) => ({ default: m.SearchPage }))) },
  "/memory": { page: lazy(() => import("@/pages/memory").then((m) => ({ default: m.MemoryPage }))) },
  "/labels": { page: lazy(() => import("@/pages/labels").then((m) => ({ default: m.LabelsPage }))) },
  "/labels/:labelId": {
    page: lazy(() => import("@/pages/label-detail").then((m) => ({ default: m.LabelDetailPage }))),
  },
  "/files": { page: lazy(() => import("@/pages/files").then((m) => ({ default: m.FilesPage }))) },
  "/agenda": { page: lazy(() => import("@/pages/outcomes").then((m) => ({ default: m.OutcomesPage }))) },
}

/** Outside every route, so the pane's own location needn't sit under the route around it. */
const NO_ROUTE = { outlet: null, matches: [], isDataRoute: false }

function Ready() {
  useRevealReady(true)
  return null
}

/**
 * A workspace page in its pane, at the pane's own path and query rather than the URL's: its params, location
 * and search params are the pane's. Its links and navigations go through the pane, changing it in place or
 * taking its tab, and anything a pane can't hold goes to the router.
 */
export function PageRoutes({
  workspaceId,
  path,
  pattern,
}: {
  workspaceId: string
  path: string
  pattern: PagePanePattern
}) {
  const { pageSearch, navigateIn } = usePanel()
  const navigation = useContext(UNSAFE_NavigationContext)
  // Pages keep `navigate` in effect deps, so the navigator stays the same while the pane's context changes.
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
  const { page: Page, reportsReady } = PAGES[pattern]
  // The pane's context changes on every layout change; the page needn't render with it.
  const routes = useMemo(
    () => (
      <Routes location={{ pathname: `/w/${workspaceId}${path}`, search: pageSearch ? `?${pageSearch}` : "" }}>
        <Route path={`/w/:workspaceId${pattern}`} element={<Page />} />
      </Routes>
    ),
    [workspaceId, path, pageSearch, pattern, Page]
  )
  return (
    <UNSAFE_RouteContext.Provider value={NO_ROUTE}>
      <UNSAFE_NavigationContext.Provider value={paneNavigation}>
        <Suspense fallback={null}>
          {routes}
          {!reportsReady && <Ready />}
        </Suspense>
      </UNSAFE_NavigationContext.Provider>
    </UNSAFE_RouteContext.Provider>
  )
}
