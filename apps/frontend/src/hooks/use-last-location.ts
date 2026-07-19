import { useEffect, useMemo } from "react"
import { useLocation, useMatch } from "react-router-dom"
import { useAuth } from "@/auth"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import {
  buildBoardHref,
  getLastLocation,
  setLastLocation,
  clearLastLocation,
  sanitizeBoardSearch,
} from "@/lib/last-location"
import type { CachedStream } from "@/db"

interface UseLastLocationResult {
  /** Stream ID to redirect to, or null when the board arm or a fallback applies. */
  redirectStreamId: string | null
  /** Explicit board URL to redirect to when the last surface was the board. */
  boardHref: string | null
  /** True when bootstrap is loaded and the workspace has zero streams. */
  shouldOpenSidebar: boolean
}

/**
 * Resolves where the workspace index route should land, restoring the last
 * surface (stream or board) the viewer was on.
 *
 * Board arm: a stored board record resolves straight to the board URL, with the
 * query sanitized and stale scope ids swept inside {@link buildBoardHref}.
 *
 * Stream arm (unchanged): stored stream validated against bootstrap, most-
 * recently-active fallback, and `shouldOpenSidebar` only once bootstrap has
 * confirmed zero streams. Evicts a stale record via `useEffect`.
 */
export function useLastLocation(workspaceId: string): UseLastLocationResult {
  const { user } = useAuth()
  const allStreams = useWorkspaceStreams(workspaceId)

  const result = useMemo(() => {
    // The stream cache durably holds archived rows (archived-stream index).
    // They must not count as landing targets: archiving bumps updated_at, so an
    // unfiltered most-recent fallback would redirect a fresh device INTO the
    // most-recently-archived stream, and a workspace whose only streams are
    // archived must still land on the fresh-start state.
    const streams = allStreams.filter((s) => !s.archivedAt)
    const record = user ? getLastLocation(user.id, workspaceId) : null

    if (record?.surface === "board" && record.board) {
      return {
        redirectStreamId: null,
        boardHref: buildBoardHref(
          workspaceId,
          record.board,
          streams.map((s) => s.id)
        ),
        shouldOpenSidebar: false,
        staleStoredId: false,
      }
    }

    const storedId = record?.streamId ?? null
    if (storedId) {
      // Deliberately checked against ALL rows: a stored pointer to a stream
      // archived since the last visit is still viewable, so honor it rather
      // than evicting the record. Only the fallbacks below exclude archived.
      const stillExists = allStreams.some((s) => s.id === storedId)
      if (stillExists) {
        return {
          redirectStreamId: storedId,
          boardHref: null,
          shouldOpenSidebar: false,
          staleStoredId: false,
        }
      }
      return {
        redirectStreamId: streams.length > 0 ? getMostRecentStreamId(streams) : null,
        boardHref: null,
        shouldOpenSidebar: streams.length === 0,
        staleStoredId: true,
      }
    }

    if (streams.length > 0) {
      return {
        redirectStreamId: getMostRecentStreamId(streams),
        boardHref: null,
        shouldOpenSidebar: false,
        staleStoredId: false,
      }
    }

    return {
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: true,
      staleStoredId: false,
    }
  }, [user, workspaceId, allStreams])

  useEffect(() => {
    if (result.staleStoredId && user) {
      clearLastLocation(user.id, workspaceId)
    }
  }, [result.staleStoredId, user, workspaceId])

  return result
}

/**
 * Persists the current surface — a stream page or the board — for
 * restore-on-return. On the board it retains the last visited stream (so the
 * "← Chats" affordance has a target); on a stream it retains the last board
 * state. The board search is sanitized to the filter axes before storage.
 */
export function usePersistLastLocation(workspaceId: string | undefined) {
  const { user } = useAuth()
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const boardMatch = useMatch("/w/:workspaceId/board")
  const search = useLocation().search

  const streamId = streamMatch?.params.streamId
  const onBoard = boardMatch !== null

  useEffect(() => {
    if (!user || !workspaceId) return
    if (onBoard) {
      const existing = getLastLocation(user.id, workspaceId)
      setLastLocation(user.id, workspaceId, {
        surface: "board",
        streamId: existing?.streamId ?? null,
        board: { search: sanitizeBoardSearch(search) },
      })
      return
    }
    if (streamId) {
      const existing = getLastLocation(user.id, workspaceId)
      setLastLocation(user.id, workspaceId, {
        surface: "stream",
        streamId,
        board: existing?.board ?? null,
      })
    }
  }, [user, workspaceId, streamId, search, onBoard])
}

function getMostRecentStreamId(streams: CachedStream[]): string {
  const sorted = [...streams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sorted[0]?.id ?? streams[0].id
}
