import { useMemo } from "react"
import { useLocation } from "react-router-dom"
import type { BoardLens } from "@threa/types"
import type { BoardViewSelection } from "@/components/board/board-saved-views"
import {
  BOARD_LENS_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  parseIdListParam,
  parseLensParam,
  parseTypeListParam,
} from "@/components/board/board-filter-params"

export interface BoardSelectionState {
  /** The lens the current URL is on (`?lens=`, degrading to the default). */
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
  const currentLens = parseLensParam(new URLSearchParams(location.search).get(BOARD_LENS_PARAM))

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

  return { currentLens, selection }
}
