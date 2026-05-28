import { useEffect, useRef } from "react"

const DEFAULT_AWAY_THRESHOLD_MS = 10_000

/**
 * Fires `onResume` when the page becomes active again after being "away" for at
 * least `awayThresholdMs` (default 10s).
 *
 * "Away" covers two distinct cases so the callback fires whether the user left
 * to another tab/app or just clicked into a different window:
 *   - the tab was hidden (`visibilitychange` → "hidden"); and
 *   - the window lost focus (`blur`) while the tab itself stayed visible — the
 *     desktop app-switch case, where `visibilitychange` never fires.
 *
 * The focus path matters because the message bootstrap queries opt out of
 * React Query's window-focus refetch, so without it, switching from another
 * desktop app back to an already-visible Threa window triggered no refresh at
 * all: messages that arrived while the socket sat idle (or had silently
 * zombied) only appeared after a hard reload.
 *
 * The threshold filters out quick app-switcher previews and momentary focus
 * loss (e.g. a file dialog), so the callback only runs when the page was away
 * long enough that socket events may have been missed. A single `awaySince`
 * timestamp is shared across both event sources, so a tab switch — which fires
 * both `visibilitychange` and a window `blur`/`focus` pair — still resumes
 * exactly once.
 *
 * `onResume` is stored in a ref so consumers don't need to memoize.
 */
export function usePageResume(onResume: () => void, awayThresholdMs: number = DEFAULT_AWAY_THRESHOLD_MS): void {
  const onResumeRef = useRef(onResume)
  onResumeRef.current = onResume

  useEffect(() => {
    let awaySince: number | null = null

    const markAway = () => {
      if (awaySince === null) awaySince = Date.now()
    }

    const markBack = () => {
      // Only resume once the page is genuinely active again — a stray focus
      // event while the tab is still hidden must not consume the away window.
      if (document.visibilityState !== "visible") return
      if (awaySince !== null && Date.now() - awaySince >= awayThresholdMs) {
        onResumeRef.current()
      }
      awaySince = null
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") markAway()
      else markBack()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("blur", markAway)
    window.addEventListener("focus", markBack)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("blur", markAway)
      window.removeEventListener("focus", markBack)
    }
  }, [awayThresholdMs])
}
