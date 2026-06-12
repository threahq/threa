import { isDraftPanel, isViewPanel } from "@/contexts/panel-context"

/**
 * Mapping between panel ids and main-view routes. A panel id is either a
 * stream id (renders the stream/thread surface), a "draft:parent:message"
 * draft thread (panel-only — it has no route of its own), or a "view:<name>"
 * named surface ("view:saved", "view:activity:unread", …) whose extra
 * segments carry the sub-view so tab state stays URL-driven inside a panel
 * (INV-59).
 */

/** Named view surfaces that can render both as a routed page and in a panel. */
export const PANEL_VIEWS = ["saved", "activity"] as const
export type PanelView = (typeof PANEL_VIEWS)[number]

export function parseViewPanel(panelId: string): { view: PanelView; subView: string | null } | null {
  if (!isViewPanel(panelId)) return null
  const [, view, subView] = panelId.split(":")
  if (!PANEL_VIEWS.includes(view as PanelView)) return null
  return { view: view as PanelView, subView: subView ?? null }
}

export function createViewPanelId(view: PanelView, subView?: string | null): string {
  return subView ? `view:${view}:${subView}` : `view:${view}`
}

/**
 * The main-view path a panel promotes to, or null when the panel has no
 * routed equivalent (draft threads).
 */
export function panelIdToMainPath(workspaceId: string, panelId: string): string | null {
  if (isDraftPanel(panelId)) return null
  const view = parseViewPanel(panelId)
  if (view) {
    const base = `/w/${workspaceId}/${view.view}`
    return view.subView ? `${base}/${view.subView}` : base
  }
  if (isViewPanel(panelId)) return null
  return `/w/${workspaceId}/s/${panelId}`
}

/**
 * The panel id equivalent of the current main-view route, or null when the
 * page can't live in a panel (settings-ish pages, workspace home).
 * Used by drag-to-main swap: the dropped panel becomes the main view and the
 * previous main view takes over the vacated panel slot.
 */
export function mainPathToPanelId(pathname: string): string | null {
  const streamMatch = pathname.match(/^\/w\/[^/]+\/s\/([^/]+)/)
  if (streamMatch) return streamMatch[1]
  const viewMatch = pathname.match(/^\/w\/[^/]+\/(saved|activity)(?:\/([^/]+))?/)
  if (viewMatch) {
    return createViewPanelId(viewMatch[1] as PanelView, viewMatch[2] ?? null)
  }
  return null
}
