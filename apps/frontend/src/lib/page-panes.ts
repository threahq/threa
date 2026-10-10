import { matchPath } from "react-router-dom"
import { isPagePane } from "./stream-ids"

/** The workspace pages that open as panes, by their path under `/w/:workspaceId`, with their tab titles. */
export const PAGE_PANES = {
  "/drafts": "Drafts",
  "/saved/:tab?": "Saved",
  "/streams/:tab?": "Streams",
  "/scheduled/:tab?": "Scheduled",
  "/board": "Board",
  "/activity/:filter?": "Activity",
  "/search": "Search",
  "/memory": "Memory",
  "/labels": "Labels",
  "/labels/:labelId": "Label",
  "/files": "Files",
  "/agenda": "Agent agenda",
} as const

export type PagePanePattern = keyof typeof PAGE_PANES

const PAGE_PREFIX = "page:"

function patternOf(path: string): PagePanePattern | null {
  return (Object.keys(PAGE_PANES) as PagePanePattern[]).find((pattern) => matchPath(pattern, path)) ?? null
}

/**
 * The pane showing a workspace page at `pathname`: `page:` and the page's path
 * in its workspace (`page:activity/unread`). Null where it is no such page.
 */
export function pagePaneAt(pathname: string): string | null {
  const match = matchPath("/w/:workspaceId/*", pathname)
  const path = `/${match?.params["*"] ?? ""}`.replace(/(.)\/$/, "$1")
  if (!match || patternOf(path) === null) return null
  return `${PAGE_PREFIX}${path.slice(1)}`
}

/** The path under `/w/:workspaceId` a page pane shows, or null when `panelId` is no page {@link PAGE_PANES} lists. */
export function pagePathOf(panelId: string): string | null {
  if (!panelId.startsWith(PAGE_PREFIX)) return null
  const path = `/${panelId.slice(PAGE_PREFIX.length)}`
  return patternOf(path) === null ? null : path
}

/** The {@link PAGE_PANES} route a page pane shows, which its filters and tabs leave the same. */
export function pagePatternOf(panelId: string): PagePanePattern | null {
  const path = pagePathOf(panelId)
  return path === null ? null : patternOf(path)
}

/** The tab title of a page pane {@link PAGE_PANES} lists. */
export function pageTitleOf(panelId: string): string | null {
  const pattern = pagePatternOf(panelId)
  return pattern === null ? null : PAGE_PANES[pattern]
}

/** A page only its own route shows, pinned in the first column (the persona editor): never in `?panel=`, never moved. */
export function isPinnedPagePane(panelId: string): boolean {
  return isPagePane(panelId) && pagePathOf(panelId) === null
}
