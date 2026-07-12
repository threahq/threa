import { useEffect, useMemo } from "react"
import { useLocation, useMatch } from "react-router-dom"
import { useAuth } from "@/auth"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useFeatureFlagWhenKnown } from "@/hooks/use-feature-flags"
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
  /** Board surface chosen but the `board-view` flag isn't known yet — render nothing. */
  pendingBoardFlag: boolean
}

/**
 * Resolves where the workspace index route should land, restoring the last
 * surface (stream or board) the viewer was on.
 *
 * Board arm: requires the `board-view` flag to be known and `"on"` (render
 * nothing while unknown, mirroring the board page's own gate; flag off falls
 * through to the stream arm using the retained last stream). The lens is
 * validated and stale scope ids swept inside {@link buildBoardHref}.
 *
 * Stream arm (unchanged): stored stream validated against bootstrap, most-
 * recently-active fallback, and `shouldOpenSidebar` only once bootstrap has
 * confirmed zero streams. Evicts a stale record via `useEffect`.
 */
export function useLastLocation(workspaceId: string): UseLastLocationResult {
  const { user } = useAuth()
  const streams = useWorkspaceStreams(workspaceId)
  const boardFlag = useFeatureFlagWhenKnown(workspaceId, "board-view")

  const result = useMemo(() => {
    const record = user ? getLastLocation(user.id, workspaceId) : null

    if (record?.surface === "board" && record.board) {
      if (boardFlag === null) {
        return {
          redirectStreamId: null,
          boardHref: null,
          shouldOpenSidebar: false,
          pendingBoardFlag: true,
          staleStoredId: false,
        }
      }
      if (boardFlag === "on") {
        return {
          redirectStreamId: null,
          boardHref: buildBoardHref(
            workspaceId,
            record.board,
            streams.map((s) => s.id)
          ),
          shouldOpenSidebar: false,
          pendingBoardFlag: false,
          staleStoredId: false,
        }
      }
      // Flag off: fall through to the stream arm using the retained stream id.
    }

    const storedId = record?.streamId ?? null
    if (storedId) {
      const stillExists = streams.some((s) => s.id === storedId)
      if (stillExists) {
        return {
          redirectStreamId: storedId,
          boardHref: null,
          shouldOpenSidebar: false,
          pendingBoardFlag: false,
          staleStoredId: false,
        }
      }
      return {
        redirectStreamId: streams.length > 0 ? getMostRecentStreamId(streams) : null,
        boardHref: null,
        shouldOpenSidebar: streams.length === 0,
        pendingBoardFlag: false,
        staleStoredId: true,
      }
    }

    if (streams.length > 0) {
      return {
        redirectStreamId: getMostRecentStreamId(streams),
        boardHref: null,
        shouldOpenSidebar: false,
        pendingBoardFlag: false,
        staleStoredId: false,
      }
    }

    return {
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: true,
      pendingBoardFlag: false,
      staleStoredId: false,
    }
  }, [user, workspaceId, streams, boardFlag])

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
  const boardMatch = useMatch("/w/:workspaceId/board/:lens?")
  const search = useLocation().search

  const streamId = streamMatch?.params.streamId
  const lens = boardMatch?.params.lens ?? null
  const onBoard = boardMatch !== null

  useEffect(() => {
    if (!user || !workspaceId) return
    if (onBoard) {
      const existing = getLastLocation(user.id, workspaceId)
      setLastLocation(user.id, workspaceId, {
        surface: "board",
        streamId: existing?.streamId ?? null,
        board: { lens, search: sanitizeBoardSearch(search) },
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
  }, [user, workspaceId, streamId, lens, search, onBoard])
}

function getMostRecentStreamId(streams: CachedStream[]): string {
  const sorted = [...streams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sorted[0]?.id ?? streams[0].id
}
