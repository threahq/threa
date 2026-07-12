import { useMemo } from "react"
import { useLocation, useMatch } from "react-router-dom"
import { DEFAULT_BOARD_LENS, type BoardLens } from "@threa/types"
import { usePreferencesOptional } from "@/contexts"
import type { BoardViewSelection } from "@/components/board/board-saved-views"
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

export interface BoardSelectionState {
  /** The viewer's home lens (the one the bare `/board` URL resolves to). */
  homeLens: BoardLens
  /** The lens the current URL is on (route segment, falling back to home). */
  currentLens: BoardLens
  /** The live six-axis filter selection parsed off the URL. */
  selection: BoardViewSelection
}

/**
 * The board selection as derived from the current URL — one derivation shared
 * by every sidebar surface that reads it (board block, filter chips), so a new
 * axis or param rename lands in exactly one place (INV-35; same reason
 * `lensHref`/`savedViewHref` are centralized).
 */
export function useBoardSelection(): BoardSelectionState {
  const location = useLocation()
  const lensMatch = useMatch("/w/:workspaceId/board/:lens?")
  const homeLens: BoardLens = usePreferencesOptional()?.preferences?.boardDefaultLens ?? DEFAULT_BOARD_LENS
  const currentLens: BoardLens = (lensMatch?.params.lens as BoardLens | undefined) ?? homeLens

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

  return { homeLens, currentLens, selection }
}
