import { useEffect, useRef, useState } from "react"

const SOFT_THRESHOLD = 70
const HARD_THRESHOLD = 120
const MAX_PULL = 150
const RESISTANCE = 0.4

export type PullMode = "idle" | "soft" | "hard"

/** Find the nearest ancestor with vertical overflow scrolling. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  while (el) {
    if (el.scrollHeight > el.clientHeight) {
      const { overflowY } = getComputedStyle(el)
      if (overflowY === "auto" || overflowY === "scroll") return el
    }
    el = el.parentElement
  }
  return null
}

interface PullToRefreshOptions {
  enabled: boolean
  /** Callback for soft refresh (re-fetch data). Hard refresh always reloads the page. */
  onRefresh?: () => Promise<void>
}

export function usePullToRefresh({ enabled, onRefresh }: PullToRefreshOptions) {
  const ref = useRef<HTMLDivElement>(null)
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  })

  useEffect(() => {
    if (!enabled) {
      setDistance(0)
      setRefreshing(false)
      return
    }
    const container = ref.current
    if (!container) return

    let startY = 0
    let scrollEl: HTMLElement | null = null
    let pulling = false
    let suppressed = false
    let isRefreshing = false
    let dist = 0
    let crossedSoft = false
    let crossedHard = false
    let reloadTimer: ReturnType<typeof setTimeout> | null = null

    function onTouchStart(e: TouchEvent) {
      if (isRefreshing) return
      const target = e.target instanceof Element ? e.target : null
      suppressed = !!target?.closest("[data-suppress-pull-refresh]")
      if (suppressed) return
      startY = e.touches[0].clientY
      scrollEl = findScrollParent(target as HTMLElement | null)
      pulling = false
      crossedSoft = false
      crossedHard = false
    }

    function onTouchMove(e: TouchEvent) {
      if (isRefreshing || suppressed) return
      const dy = e.touches[0].clientY - startY

      if (dy <= 0) {
        if (pulling) {
          pulling = false
          dist = 0
          setDistance(0)
        }
        return
      }

      if (scrollEl && scrollEl.scrollTop > 1) return

      // Stream scroll containers use infinite scroll, not pull-to-refresh.
      if (scrollEl && scrollEl.dataset.suppressPullRefresh) return

      e.preventDefault()

      const d = Math.min(dy * RESISTANCE, MAX_PULL)
      if (d > 5) {
        pulling = true
        dist = d
        setDistance(d)

        if (d >= HARD_THRESHOLD && !crossedHard) {
          crossedHard = true
          navigator.vibrate?.([15, 30, 15])
        }
        if (d < HARD_THRESHOLD && crossedHard) {
          crossedHard = false
          navigator.vibrate?.(10)
        }

        if (d >= SOFT_THRESHOLD && !crossedSoft) {
          crossedSoft = true
          navigator.vibrate?.(10)
        }
        if (d < SOFT_THRESHOLD) crossedSoft = false
      }
    }

    function onTouchEnd() {
      if (suppressed) {
        suppressed = false
        return
      }
      if (!pulling) return
      pulling = false

      if (dist >= HARD_THRESHOLD) {
        isRefreshing = true
        setRefreshing(true)
        setDistance(HARD_THRESHOLD)
        reloadTimer = setTimeout(() => window.location.reload(), 400)
      } else if (dist >= SOFT_THRESHOLD) {
        isRefreshing = true
        setRefreshing(true)
        setDistance(SOFT_THRESHOLD)

        const promise = onRefreshRef.current?.() ?? Promise.resolve()
        promise.finally(() => {
          setTimeout(() => {
            isRefreshing = false
            setRefreshing(false)
            setDistance(0)
          }, 300)
        })
      } else {
        dist = 0
        setDistance(0)
      }
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true })
    container.addEventListener("touchmove", onTouchMove, { passive: false })
    container.addEventListener("touchend", onTouchEnd)
    container.addEventListener("touchcancel", onTouchEnd)

    return () => {
      container.removeEventListener("touchstart", onTouchStart)
      container.removeEventListener("touchmove", onTouchMove)
      container.removeEventListener("touchend", onTouchEnd)
      container.removeEventListener("touchcancel", onTouchEnd)
      if (reloadTimer) clearTimeout(reloadTimer)
    }
  }, [enabled])

  let mode: PullMode = "idle"
  if (distance >= HARD_THRESHOLD) mode = "hard"
  else if (distance >= SOFT_THRESHOLD) mode = "soft"

  return {
    ref,
    distance,
    progress: Math.min(distance / SOFT_THRESHOLD, 1),
    pulling: distance > 0 && !refreshing,
    refreshing,
    mode,
  }
}
