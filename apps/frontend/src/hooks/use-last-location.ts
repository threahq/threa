import { useEffect, useMemo } from "react"
import { useLocation, useMatch } from "react-router-dom"
import { useAuth } from "@/auth"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import {
  buildBoardHref,
  freshExactPath,
  getLastLocation,
  setLastLocation,
  sanitizeBoardSearch,
} from "@/lib/last-location"
import type { CachedStream } from "@/db"

// The exact arm serves only a cold launch — the OS killed the backgrounded PWA
// and relaunched it at `start_url`. Once this JS context has rendered any
// workspace page, arriving at the index is a deliberate "go home" (back
// arrows, the quick switcher, StreamErrorView's escape link); restoring exact
// there would bounce the viewer straight back to the page they just left.
let coldLaunch = true

export function resetColdLaunchForTests(): void {
  coldLaunch = true
}

interface UseLastLocationResult {
  /** Exact URL to restore verbatim after a fresh crash/kill relaunch. */
  exactPath: string | null
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
 * Exact arm: on a cold launch only (see `coldLaunch`), a fresh exact record
 * (the PWA was killed while backgrounded and relaunched at `start_url` shortly
 * after) restores the URL verbatim — including `?panel=`/`?m=` and non-stream
 * pages the sanitized arms don't cover.
 *
 * Board arm: a stored board record resolves to the board URL, with the query
 * sanitized and stale scope ids swept inside {@link buildBoardHref}.
 *
 * Stream arm: stored stream validated against bootstrap, most-recently-active
 * fallback, and `shouldOpenSidebar` only once bootstrap has confirmed zero
 * streams. A stored id absent from the cache is NOT evicted: the cache can't
 * distinguish a deleted stream from a lazily-hydrated thread/conversation, and
 * the record self-heals on the next persisted navigation anyway.
 */
export function useLastLocation(workspaceId: string): UseLastLocationResult {
  const { user } = useAuth()
  const allStreams = useWorkspaceStreams(workspaceId)

  return useMemo(() => {
    // The stream cache durably holds archived rows (archived-stream index).
    // They must not count as landing targets: archiving bumps updated_at, so an
    // unfiltered most-recent fallback would redirect a fresh device INTO the
    // most-recently-archived stream, and a workspace whose only streams are
    // archived must still land on the fresh-start state.
    const streams = allStreams.filter((s) => !s.archivedAt)
    const record = user ? getLastLocation(user.id, workspaceId) : null

    const exactPath = coldLaunch ? freshExactPath(record, workspaceId, Date.now()) : null
    if (exactPath) {
      return { exactPath, redirectStreamId: null, boardHref: null, shouldOpenSidebar: false }
    }

    if (record?.surface === "board" && record.board) {
      return {
        exactPath: null,
        redirectStreamId: null,
        boardHref: buildBoardHref(
          workspaceId,
          record.board,
          streams.map((s) => s.id)
        ),
        shouldOpenSidebar: false,
      }
    }

    const storedId = record?.streamId ?? null
    if (storedId) {
      // Deliberately checked against ALL rows: a stored pointer to a stream
      // archived since the last visit is still viewable, so honor it rather
      // than falling back. Only the fallbacks below exclude archived.
      const stillExists = allStreams.some((s) => s.id === storedId)
      if (stillExists) {
        return {
          exactPath: null,
          redirectStreamId: storedId,
          boardHref: null,
          shouldOpenSidebar: false,
        }
      }
      return {
        exactPath: null,
        redirectStreamId: streams.length > 0 ? getMostRecentStreamId(streams) : null,
        boardHref: null,
        shouldOpenSidebar: streams.length === 0,
      }
    }

    if (streams.length > 0) {
      return {
        exactPath: null,
        redirectStreamId: getMostRecentStreamId(streams),
        boardHref: null,
        shouldOpenSidebar: false,
      }
    }

    return {
      exactPath: null,
      redirectStreamId: null,
      boardHref: null,
      shouldOpenSidebar: true,
    }
  }, [user, workspaceId, allStreams])
}

/**
 * Persists the current surface — a stream page or the board — for
 * restore-on-return, plus the exact URL of every workspace page for verbatim
 * restore after a crash-relaunch. On the board it retains the last visited
 * stream (so the "← Chats" affordance has a target); on a stream it retains
 * the last board state. The board search is sanitized to the filter axes
 * before storage.
 */
export function usePersistLastLocation(workspaceId: string | undefined) {
  const { user } = useAuth()
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const boardMatch = useMatch("/w/:workspaceId/board")
  const { pathname, search } = useLocation()

  const streamId = streamMatch?.params.streamId
  const onBoard = boardMatch !== null

  useEffect(() => {
    if (!user || !workspaceId) return
    // Transient redirect hops are never a place to restore to. The bare index
    // would loop the exact restore; /delegations/:id 404s away to the index
    // (routes/index.tsx DelegationRedirect), so restoring it would loop the
    // 404 toast; /memos/:id is its sibling alias.
    if (pathname === `/w/${workspaceId}`) return
    // Only a page beyond the index warms the session: WorkspaceLayout mounts
    // this hook OUTSIDE CoordinatedLoadingGate, so on a cold launch this effect
    // runs at the index pathname before the gated WorkspaceHome renders — if
    // that visit warmed, the exact arm would never serve.
    coldLaunch = false
    if (pathname.startsWith(`/w/${workspaceId}/delegations/`) || pathname.startsWith(`/w/${workspaceId}/memos/`)) return
    const persist = () => {
      const exact = { path: `${pathname}${search}`, at: Date.now() }
      const existing = getLastLocation(user.id, workspaceId)
      if (onBoard) {
        setLastLocation(user.id, workspaceId, {
          surface: "board",
          streamId: existing?.streamId ?? null,
          board: { search: sanitizeBoardSearch(search) },
          exact,
        })
        return
      }
      if (streamId) {
        setLastLocation(user.id, workspaceId, {
          surface: "stream",
          streamId,
          board: existing?.board ?? null,
          exact,
        })
        return
      }
      // Other workspace pages (activity, saved, memory, …): keep the
      // stream/board arms as they were, record only the exact URL.
      setLastLocation(user.id, workspaceId, {
        surface: existing?.surface ?? "stream",
        streamId: existing?.streamId ?? null,
        board: existing?.board ?? null,
        exact,
      })
    }
    persist()
    // Backgrounding is the last moment we run before an OS kill — re-persist so
    // the exact record's freshness measures time-since-last-seen. This tab's
    // OWN page is re-written, never a bump of whatever is stored: another tab
    // (an externally-opened link) may have written since, and re-stamping its
    // record would extend the wrong page's freshness with this tab's signal.
    // Only the tab transitioning visible→hidden fires; a tab that is already
    // hidden gets no visibilitychange when the whole browser backgrounds.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [user, workspaceId, streamId, search, onBoard, pathname])
}

function getMostRecentStreamId(streams: CachedStream[]): string {
  const sorted = [...streams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sorted[0]?.id ?? streams[0].id
}
