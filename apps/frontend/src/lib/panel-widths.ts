/**
 * Per-panel widths persisted across refreshes. The URL already persists WHICH
 * panels are open; this persists how WIDE each one is, so a refresh restores
 * the exact arrangement instead of resetting to the default width.
 *
 * Keyed by panel id (the content — stream id / draft / view), scoped per
 * workspace, in localStorage. Width travels with the content: a stream's panel
 * keeps its width across reorders and sessions, not with the strip position.
 */
const storageKey = (workspaceId: string) => `threa:panel-widths:${workspaceId}`

export function loadPanelWidths(workspaceId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, number> = {}
    for (const [id, width] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof width === "number" && Number.isFinite(width) && width > 0) out[id] = width
    }
    return out
  } catch {
    return {}
  }
}

export function savePanelWidth(workspaceId: string, panelId: string, width: number): void {
  try {
    const all = loadPanelWidths(workspaceId)
    all[panelId] = Math.round(width)
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(all))
  } catch {
    // localStorage unavailable (private mode, quota) — widths just won't persist.
  }
}
