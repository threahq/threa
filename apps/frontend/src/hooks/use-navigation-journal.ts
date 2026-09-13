import { useCallback, useEffect, useSyncExternalStore } from "react"
import { useLocation, useNavigationType } from "react-router-dom"
import { useAuth } from "@/auth"
import { hiddenStreamIds } from "@/lib/streams"
import { useWorkspaceStreams, useWorkspaceStreamsLoaded } from "@/stores/workspace-store"
import {
  EMPTY_JOURNAL,
  isJournaledPath,
  journalPath,
  journalStreamIds,
  journalTarget,
  journalVisit,
  readJournal,
  recentStreams,
  subscribeJournal,
  type JournalStep,
  type NavigationJournal,
  type RecentStream,
} from "@/lib/navigation-journal"

export type { JournalStep }

/**
 * Records every workspace page the viewer lands on into the per-user journal
 * that drives the sidebar's history control. Same exclusions as
 * `usePersistLastLocation`: the bare index, `/delegations/*`, `/memos/*`, and
 * anything showing a hidden (aside-rooted) stream.
 */
export function useRecordNavigationJournal(workspaceId: string | undefined): void {
  const { user } = useAuth()
  const { pathname, search, state } = useLocation()
  const navigationType = useNavigationType()
  const cachedStreams = useWorkspaceStreams(workspaceId ?? "")
  // Before the streams table hydrates the hidden set is empty and an aside
  // page would be recorded; the entry has no cleanup path, so wait.
  const streamsLoaded = useWorkspaceStreamsLoaded(workspaceId)

  const journalCursor: unknown = (state as { journalCursor?: unknown } | null)?.journalCursor
  const cursorHint = typeof journalCursor === "number" ? journalCursor : undefined

  useEffect(() => {
    if (!user || !workspaceId || !streamsLoaded) return
    if (!isJournaledPath(pathname, workspaceId)) return
    const path = journalPath({ pathname, search })
    const hidden = hiddenStreamIds(cachedStreams)
    if (journalStreamIds(path, workspaceId).some((id) => hidden.has(id))) return
    journalVisit(user.id, workspaceId, path, { cursorHint, navigationType })
  }, [user, workspaceId, streamsLoaded, pathname, search, cursorHint, navigationType, cachedStreams])
}

export interface NavigationJournalView {
  back: JournalStep | null
  forward: JournalStep | null
  recent: RecentStream[]
  /**
   * Moves the cursor now, before the router commits the step. The recorder
   * above runs after React's transition commit, which can trail the URL by a
   * frame or, with a phone's aside sheet mounted, by seconds; a second step
   * issued in that window (Ctrl+[ then Ctrl+]) would otherwise read the stale
   * cursor and go nowhere. The later recorder pass sees the page already at
   * the cursor and writes nothing.
   */
  step: (target: JournalStep) => void
}

/** Live read of the journal for the history menu. */
export function useNavigationJournal(workspaceId: string): NavigationJournalView {
  const { user } = useAuth()
  const userId = user?.id

  const subscribe = useCallback(
    (listener: () => void) => (userId ? subscribeJournal(userId, workspaceId, listener) : () => {}),
    [userId, workspaceId]
  )
  const getSnapshot = useCallback(
    (): NavigationJournal => (userId ? readJournal(userId, workspaceId) : EMPTY_JOURNAL),
    [userId, workspaceId]
  )
  const journal = useSyncExternalStore(subscribe, getSnapshot)
  const step = useCallback(
    (target: JournalStep) => {
      if (!userId) return
      journalVisit(userId, workspaceId, target.to, { cursorHint: target.state.journalCursor, navigationType: "PUSH" })
    },
    [userId, workspaceId]
  )

  return {
    back: journalTarget(journal, -1),
    forward: journalTarget(journal, 1),
    recent: recentStreams(journal, workspaceId),
    step,
  }
}
