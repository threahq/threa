import { useEffect, useState } from "react"
import { isScrollDebugEnabled } from "@/lib/scroll-debug"

interface ScrollDebugHudProps {
  /** The owned timeline scroller, so we can read its live scroll metrics. */
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Live follow state from useTimelineScroll. */
  isFollowingTailRef: React.MutableRefObject<boolean>
}

/**
 * On-screen readout of the live scroll / viewport / composer metrics, for
 * diagnosing the mobile keyboard behaviour without a remote debugger. Opt-in via
 * the same flag as the console tracing (`localStorage.threaScrollDebug = "1"` or
 * `?scrolldebug=1`); renders nothing otherwise. Self-contained and easy to
 * delete once the timeline scroll behaviour is locked in.
 *
 * The decisive question it answers: when the keyboard opens, does the scroller's
 * `ch` (clientHeight) shrink? If yes, pinning to the bottom lifts the tail above
 * the keyboard. If `ch` stays put while `vvH` shrinks, the keyboard is overlaying
 * the scroller and pinning alone can't help.
 */
export function ScrollDebugHud({ scrollerRef, isFollowingTailRef }: ScrollDebugHudProps) {
  const enabled = isScrollDebugEnabled()
  const [, bump] = useState(0)

  // Sample a few times a second (not every frame) so the readout reflects live
  // changes during the keyboard animation without itself janking what we measure.
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => bump((n) => (n + 1) & 0xffff), 100)
    return () => window.clearInterval(id)
  }, [enabled])

  if (!enabled) return null

  const el = scrollerRef.current
  const vv = typeof window !== "undefined" ? window.visualViewport : null
  const ch = el?.clientHeight ?? 0
  const sh = el?.scrollHeight ?? 0
  const st = Math.round(el?.scrollTop ?? 0)
  const dist = sh - st - ch
  const composer = el ? getComputedStyle(el).getPropertyValue("--composer-height").trim() || "—" : "—"

  return (
    <div className="pointer-events-none fixed left-1 top-1 z-[100] select-none rounded bg-black/80 px-2 py-1 font-mono text-[10px] leading-tight text-green-300 shadow">
      <div>
        follow={String(isFollowingTailRef.current)} dist={dist}
      </div>
      <div>
        ch={ch} sh={sh} st={st}
      </div>
      <div>
        vvH={vv ? Math.round(vv.height) : "—"} vvTop={vv ? Math.round(vv.offsetTop) : "—"} iH={window.innerHeight}
      </div>
      <div>composer={composer}</div>
    </div>
  )
}
