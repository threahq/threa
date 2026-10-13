import { lazy, Suspense, useMemo, useState, type ComponentType } from "react"
import { Route, Routes, UNSAFE_RouteContext } from "react-router-dom"
import { usePanel, useRevealReady } from "@/contexts"
import { pagePatternOf, type PagePanePattern } from "@/lib/page-panes"
import { PaneNavigation } from "./pane-navigation"

interface PageRoute {
  load: () => Promise<unknown>
  page: ComponentType
  /** Reports its own reveal readiness, rather than being ready once it renders. */
  reportsReady?: true
}

function route(load: () => Promise<ComponentType>, reportsReady?: true): PageRoute {
  let loaded: ComponentType | null = null
  const fetchPage = () =>
    loaded ? Promise.resolve({ default: loaded }) : load().then((page) => ({ default: (loaded = page) }))
  const Lazy = lazy(fetchPage)
  // A page whose chunk already arrived renders at once. A lazy one suspends on its first render even with its
  // chunk cached, and React then holds the boundary's content back for up to 300ms after showing the fallback.
  const Page = () => {
    const [Preloaded] = useState(() => loaded)
    return Preloaded ? <Preloaded /> : <Lazy />
  }
  return { load: fetchPage, page: Page, reportsReady }
}

const PAGES: Record<PagePanePattern, PageRoute> = {
  "/drafts": route(() => import("@/pages/drafts").then((m) => m.DraftsPage)),
  "/saved/:tab?": route(() => import("@/pages/saved").then((m) => m.SavedPage)),
  "/streams/:tab?": route(() => import("@/pages/streams").then((m) => m.StreamsPage)),
  "/scheduled/:tab?": route(() => import("@/pages/scheduled").then((m) => m.ScheduledPage)),
  "/board": route(() => import("@/pages/board").then((m) => m.BoardPage), true),
  "/activity/:filter?": route(() => import("@/pages/activity").then((m) => m.ActivityPage)),
  "/search": route(() => import("@/pages/search").then((m) => m.SearchPage)),
  "/memory": route(() => import("@/pages/memory").then((m) => m.MemoryPage)),
  "/labels": route(() => import("@/pages/labels").then((m) => m.LabelsPage)),
  "/labels/:labelId": route(() => import("@/pages/label-detail").then((m) => m.LabelDetailPage)),
  "/files": route(() => import("@/pages/files").then((m) => m.FilesPage)),
  "/agenda": route(() => import("@/pages/outcomes").then((m) => m.OutcomesPage)),
}

/**
 * Fetches the page `panelId` shows before its pane opens, so a page the pointer or keyboard focus is about to
 * open beside the stream shows its content inside the glide rather than after it. A failed fetch is the pane's
 * to report.
 */
export function preloadPage(panelId: string) {
  const pattern = pagePatternOf(panelId)
  if (pattern) void PAGES[pattern].load().catch(() => undefined)
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
