import { useMemo } from "react"
import { Link, useLocation, useMatch } from "react-router-dom"
import { ArrowLeft, Bookmark, Pin } from "lucide-react"
import { BOARD_LENSES, DEFAULT_BOARD_LENS, type BoardLens } from "@threa/types"
import { useSidebar, usePreferencesOptional } from "@/contexts"
import { cn } from "@/lib/utils"
import { useBoardHome, useBoardViews } from "@/hooks/use-board-views"
import { isViewActive, lensHref, savedViewHref, type BoardViewSelection } from "@/components/board/board-saved-views"
import {
  BOARD_SCOPE_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  parseIdListParam,
  parseTypeListParam,
} from "@/components/board/board-filter-params"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import { getLastLocation } from "@/lib/last-location"

interface BoardModeBlockProps {
  workspaceId: string
  /** The viewer's auth id — keys the last-location record for the "← Chats" target. */
  userId: string | null
}

const ROW_CLASS = "flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
const SECTION_LABEL_CLASS =
  "m-0 px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"

/**
 * The board block replaces the quick-links block in the sidebar while on
 * `/board` (board-centered-sidebar-exploration.md § V2 top blocks). Top-to-
 * bottom: a "← Chats" back link to the last visited stream, the viewer's saved
 * Views, and the board Lenses. Every entry is a `<Link>` — the board's whole
 * state is URL (INV-40/INV-59) — and the URLs are built with the same helpers
 * the filter bar uses (`lensHref`, `savedViewHref`) so the two surfaces can't
 * drift (INV-35). The filter axes ride along a lens switch, so scoping survives.
 */
export function BoardModeBlock({ workspaceId, userId }: BoardModeBlockProps) {
  const { collapseOnMobile } = useSidebar()
  const location = useLocation()
  const lensMatch = useMatch("/w/:workspaceId/board/:lens?")

  const preferences = usePreferencesOptional()?.preferences ?? null
  const homeLens: BoardLens = preferences?.boardDefaultLens ?? DEFAULT_BOARD_LENS

  const { data: views } = useBoardViews(workspaceId)
  const { view: homeView, configuredId: homeViewId } = useBoardHome(workspaceId)
  const hasSavedViewHome = homeViewId !== null

  const lensParam = lensMatch?.params.lens
  const currentLens: BoardLens = (lensParam as BoardLens | undefined) ?? homeLens

  // Parse the live selection off the URL so a saved view / lens can read as
  // active — reuses the board's URL vocabulary (INV-35), not a hand-rolled parse.
  const selection = useMemo<BoardViewSelection>(() => {
    const params = new URLSearchParams(location.search)
    return {
      lens: currentLens,
      scopeStreamIds: parseIdListParam(params.get(BOARD_SCOPE_PARAM)),
      scopeStreamTypes: parseTypeListParam(params.get(BOARD_TYPE_PARAM)),
      scopeLabelIds: parseIdListParam(params.get(BOARD_LABEL_PARAM)),
      excludeStreamIds: parseIdListParam(params.get(BOARD_EXCLUDE_SCOPE_PARAM)),
      excludeStreamTypes: parseTypeListParam(params.get(BOARD_EXCLUDE_TYPE_PARAM)),
      excludeLabelIds: parseIdListParam(params.get(BOARD_EXCLUDE_LABEL_PARAM)),
    }
  }, [location.search, currentLens])

  // A saved view IS the selection when the live lens + every axis match it, so it
  // — not its base lens — reads as active; a lens is active only when no view is.
  const activeViewId = views?.find((view) => isViewActive(view, selection))?.id ?? null

  const sortedViews = useMemo(() => (views ? [...views].sort((a, b) => a.sortOrder - b.sortOrder) : []), [views])

  const lastLocation = userId ? getLastLocation(userId, workspaceId) : null
  const chatsHref = lastLocation?.streamId ? `/w/${workspaceId}/s/${lastLocation.streamId}` : `/w/${workspaceId}`

  return (
    <div className="mb-2 space-y-1">
      <Link
        to={chatsHref}
        onClick={collapseOnMobile}
        className={cn(ROW_CLASS, "text-muted-foreground hover:bg-muted/50")}
      >
        <ArrowLeft className="h-4 w-4" />
        Chats
      </Link>

      {sortedViews.length > 0 && (
        <div className="pt-1">
          <h3 className={SECTION_LABEL_CLASS}>Views</h3>
          {sortedViews.map((view) => {
            const active = view.id === activeViewId
            const isHome = view.id === homeView?.id
            return (
              <Link
                key={view.id}
                to={savedViewHref(workspaceId, view, homeLens)}
                onClick={collapseOnMobile}
                aria-current={active ? "true" : undefined}
                className={cn(ROW_CLASS, active ? "bg-primary/10" : "hover:bg-muted/50 text-muted-foreground")}
              >
                {isHome ? (
                  <Pin className="h-4 w-4 shrink-0 fill-current" aria-label="Board home" />
                ) : (
                  <Bookmark className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{view.name}</span>
              </Link>
            )
          })}
        </div>
      )}

      <div className="pt-1">
        <h3 className={SECTION_LABEL_CLASS}>Lenses</h3>
        {BOARD_LENSES.map((value) => {
          const def = BOARD_LENS_DEFS[value]
          const Icon = def.icon
          const active = value === currentLens && activeViewId === null
          return (
            <Link
              key={value}
              to={lensHref(workspaceId, value, location.search, homeLens, hasSavedViewHome)}
              onClick={collapseOnMobile}
              aria-current={active ? "true" : undefined}
              className={cn(ROW_CLASS, active ? "bg-primary/10" : "hover:bg-muted/50 text-muted-foreground")}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {def.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
