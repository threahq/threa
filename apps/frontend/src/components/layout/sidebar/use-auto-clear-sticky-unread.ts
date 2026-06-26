import { useEffect, useRef } from "react"
import { usePageActivity } from "@/hooks/use-page-activity"

/** Idle delay before a sidebar left open on desktop flushes its read residue —
 *  long enough not to yank a row out from under a mid-glance read. */
const IDLE_AUTOCLEAR_MS = 15_000

interface AutoClearArgs {
  /** Whether the tray currently holds already-read streams worth flushing. */
  hasReadResidue: boolean
  /** Drop the read residue (see `useStickyUnread`). */
  clearRead: () => void
  /** Whether the sidebar is hidden (collapsed) rather than on screen. */
  sidebarHidden: boolean
}

/**
 * Auto-flush the Unread tray's read residue (see `useStickyUnread`). The tray
 * deliberately holds already-read streams so working through it doesn't reflow
 * the sidebar on every read; these triggers drop that residue once the user's
 * attention has plausibly moved on, so the tray reads fresh next time:
 *  - the sidebar is hidden (collapsed) — on mobile this lands the moment they
 *    navigate, with the list off screen so nothing visibly shifts;
 *  - the app regains focus after being backgrounded (tab/window switch);
 *  - a fairly long idle while the sidebar stays open (the desktop case).
 *
 * `clearRead` is read through a ref so its per-render identity churn (it closes
 * over the stream list) can't keep resetting the idle timer — the timer is
 * armed by the residue flag flipping, not by every stream-list update.
 */
export function useAutoClearStickyUnread({ hasReadResidue, clearRead, sidebarHidden }: AutoClearArgs): void {
  const { isFocused } = usePageActivity()

  const clearReadRef = useRef(clearRead)
  useEffect(() => {
    clearReadRef.current = clearRead
  }, [clearRead])

  // Hidden — flush immediately; the tray isn't on screen to reflow.
  useEffect(() => {
    if (sidebarHidden && hasReadResidue) clearReadRef.current()
  }, [sidebarHidden, hasReadResidue])

  // Refocus after the window was blurred — coming back counts as a fresh look.
  const wasFocused = useRef(isFocused)
  useEffect(() => {
    const regainedFocus = isFocused && !wasFocused.current
    wasFocused.current = isFocused
    if (regainedFocus && hasReadResidue) clearReadRef.current()
  }, [isFocused, hasReadResidue])

  // Left open on screen — flush after an idle beat so the tray can't linger.
  useEffect(() => {
    if (!hasReadResidue || sidebarHidden) return
    const timer = setTimeout(() => clearReadRef.current(), IDLE_AUTOCLEAR_MS)
    return () => clearTimeout(timer)
  }, [hasReadResidue, sidebarHidden])
}
