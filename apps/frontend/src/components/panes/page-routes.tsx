import { lazy, Suspense, useMemo, type ComponentType } from "react"
import { Route, Routes, UNSAFE_RouteContext } from "react-router-dom"
import { usePanel, useRevealReady } from "@/contexts"
import type { PagePanePattern } from "@/lib/page-panes"
import { PaneNavigation } from "./pane-navigation"

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
  const { pageSearch } = usePanel()
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
    <PaneNavigation>
      <UNSAFE_RouteContext.Provider value={NO_ROUTE}>
        <Suspense fallback={null}>
          {routes}
          {!reportsReady && <Ready />}
        </Suspense>
      </UNSAFE_RouteContext.Provider>
    </PaneNavigation>
  )
}
