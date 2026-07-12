import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
export const ZOOM_STEP = 1.5
export const DOUBLE_ZOOM = 2
/** Two taps within this window (and 30px) are a double-tap zoom. Consumers that
 *  act on single taps (the gallery chrome toggle) defer past this window so the
 *  first tap of a double-tap never fires their action. */
export const DOUBLE_TAP_MS = 300

interface UseZoomPanOptions {
  containerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  onZoomChange?: (zoomed: boolean) => void
  /** Called synchronously inside `commit` whenever scale changes.
   *  Avoids a React-state cascade through the parent during pinch (60fps). */
  onScaleChange?: (scale: number) => void
}

interface ZoomPanState {
  scale: number
  tx: number
  ty: number
}

const IDENTITY: ZoomPanState = { scale: 1, tx: 0, ty: 0 }

// Zoom toward an element-local point (measured from the container center).
// Holds the image-local point under the cursor invariant across the scale change.
export function zoomToPoint(state: ZoomPanState, newScale: number, px: number, py: number): ZoomPanState {
  const k = newScale / state.scale
  return {
    scale: newScale,
    tx: px * (1 - k) + state.tx * k,
    ty: py * (1 - k) + state.ty * k,
  }
}

// Clamp translate so the bitmap stays within the container at the given scale.
// baseW/baseH are the rendered dimensions at scale 1 (post-object-contain fit).
export function clampTranslate(
  state: ZoomPanState,
  containerW: number,
  containerH: number,
  baseW: number,
  baseH: number
): ZoomPanState {
  const renderedW = baseW * state.scale
  const renderedH = baseH * state.scale
  const maxTx = Math.max(0, (renderedW - containerW) / 2)
  const maxTy = Math.max(0, (renderedH - containerH) / 2)
  return {
    scale: state.scale,
    tx: Math.max(-maxTx, Math.min(maxTx, state.tx)),
    ty: Math.max(-maxTy, Math.min(maxTy, state.ty)),
  }
}

// Derive the object-contain rendered dimensions of an image inside a container.
export function fitContain(
  naturalW: number,
  naturalH: number,
  containerW: number,
  containerH: number
): { w: number; h: number } {
  if (naturalW <= 0 || naturalH <= 0 || containerW <= 0 || containerH <= 0) {
    return { w: 0, h: 0 }
  }
  const imgAspect = naturalW / naturalH
  const containerAspect = containerW / containerH
  if (imgAspect > containerAspect) {
    return { w: containerW, h: containerW / imgAspect }
  }
  return { w: containerH * imgAspect, h: containerH }
}

const TRANSITION_EASE = "transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)"

export function useZoomPan({ containerRef, contentRef, onZoomChange, onScaleChange }: UseZoomPanOptions) {
  const stateRef = useRef<ZoomPanState>(IDENTITY)
  const containerSizeRef = useRef({ w: 0, h: 0 })
  const baseSizeRef = useRef({ w: 0, h: 0 })
  const naturalSizeRef = useRef({ w: 0, h: 0 })
  const isZoomedRef = useRef(false)

  const [isZoomed, setIsZoomed] = useState(false)

  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange
  const onScaleChangeRef = useRef(onScaleChange)
  onScaleChangeRef.current = onScaleChange

  const applyTransform = useCallback(
    (transition?: boolean) => {
      const el = contentRef.current
      if (!el) return
      const { scale: s, tx, ty } = stateRef.current
      el.style.transition = transition ? TRANSITION_EASE : "none"
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
      el.style.transformOrigin = "center center"
    },
    [contentRef]
  )

  const commit = useCallback(
    (next: ZoomPanState, opts?: { transition?: boolean }) => {
      const prevScale = stateRef.current.scale
      const clamped = clampTranslate(
        next,
        containerSizeRef.current.w,
        containerSizeRef.current.h,
        baseSizeRef.current.w,
        baseSizeRef.current.h
      )
      // At scale 1, translate collapses to 0 — prevents stuck offsets after zoom-out.
      if (clamped.scale <= ZOOM_MIN + 1e-6) {
        clamped.scale = ZOOM_MIN
        clamped.tx = 0
        clamped.ty = 0
      }
      stateRef.current = clamped
      applyTransform(opts?.transition ?? false)

      const zoomed = clamped.scale > ZOOM_MIN + 1e-6
      if (zoomed !== isZoomedRef.current) {
        isZoomedRef.current = zoomed
        setIsZoomed(zoomed)
        onZoomChangeRef.current?.(zoomed)
      }
      // Synchronous fanout — subscribers (e.g. ZoomControls) update without
      // pulling the gallery through a React-state cascade at 60fps.
      if (clamped.scale !== prevScale) onScaleChangeRef.current?.(clamped.scale)
    },
    [applyTransform]
  )

  const reset = useCallback(
    (opts?: { transition?: boolean }) => {
      commit(IDENTITY, { transition: opts?.transition ?? true })
    },
    [commit]
  )

  const recomputeBase = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    containerSizeRef.current = { w: container.clientWidth, h: container.clientHeight }
    const { w: nw, h: nh } = naturalSizeRef.current
    baseSizeRef.current = fitContain(nw, nh, containerSizeRef.current.w, containerSizeRef.current.h)
    // Re-clamp against new bounds.
    commit(stateRef.current)
  }, [containerRef, commit])

  // Measure natural dimensions when the content element (an <img>) becomes available
  // or its src changes.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const captureNatural = () => {
      if (el instanceof HTMLImageElement) {
        naturalSizeRef.current = { w: el.naturalWidth, h: el.naturalHeight }
      } else {
        naturalSizeRef.current = { w: el.offsetWidth, h: el.offsetHeight }
      }
      recomputeBase()
    }

    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) {
      captureNatural()
    } else {
      el.addEventListener("load", captureNatural)
      return () => el.removeEventListener("load", captureNatural)
    }
  }, [contentRef, recomputeBase])

  // Track container resize (orientation change, window resize, panel toggle).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => recomputeBase())
    ro.observe(container)
    return () => ro.disconnect()
  }, [containerRef, recomputeBase])

  // Imperative zoom by factor toward a container-local point (defaults to center).
  const zoomBy = useCallback(
    (factor: number, localX?: number, localY?: number) => {
      const cw = containerSizeRef.current.w
      const ch = containerSizeRef.current.h
      const cx = cw / 2
      const cy = ch / 2
      const px = (localX ?? cx) - cx
      const py = (localY ?? cy) - cy
      const current = stateRef.current
      const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.scale * factor))
      if (target === current.scale) return
      commit(zoomToPoint(current, target, px, py), { transition: true })
    },
    [commit]
  )

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy])
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy])

  // ── Desktop: wheel (ctrl/meta = zoom, plain = pan when zoomed) ────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function onWheel(e: WheelEvent) {
      // Normalise to pixels so line-mode and page-mode mice don't make a single
      // scroll notch jump from 1× straight to ZOOM_MAX (or pan only 1–3 px).
      // Line height ≈ 16px, page ≈ a viewport.
      let pxPerUnit = 1
      if (e.deltaMode === 1) pxPerUnit = 16
      else if (e.deltaMode === 2) pxPerUnit = container!.clientHeight
      const dxPx = e.deltaX * pxPerUnit
      const dyPx = e.deltaY * pxPerUnit

      const zoomIntent = e.ctrlKey || e.metaKey
      if (zoomIntent) {
        e.preventDefault()
        const rect = container!.getBoundingClientRect()
        const localX = e.clientX - rect.left
        const localY = e.clientY - rect.top
        const factor = Math.exp(-dyPx * 0.01)
        const current = stateRef.current
        const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.scale * factor))
        if (target === current.scale) return
        const cx = container!.clientWidth / 2
        const cy = container!.clientHeight / 2
        commit(zoomToPoint(current, target, localX - cx, localY - cy))
      } else if (isZoomedRef.current) {
        e.preventDefault()
        const current = stateRef.current
        commit({ scale: current.scale, tx: current.tx - dxPx, ty: current.ty - dyPx })
      }
      // Not zoomed + no modifier: let the browser do nothing (dialog has nothing to scroll).
    }

    container.addEventListener("wheel", onWheel, { passive: false })
    return () => container.removeEventListener("wheel", onWheel)
  }, [containerRef, commit])

  // ── Desktop: pointer-drag pan (plain drag when zoomed, or meta/ctrl+drag) ─
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startX = 0
    let startY = 0
    let startTx = 0
    let startTy = 0
    let pointerId = -1

    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === "touch") return // touch goes through the touch handler
      if (e.button !== 0) return
      const modifierHeld = e.metaKey || e.ctrlKey
      if (!isZoomedRef.current && !modifierHeld) return
      dragging = true
      startX = e.clientX
      startY = e.clientY
      startTx = stateRef.current.tx
      startTy = stateRef.current.ty
      pointerId = e.pointerId
      container!.setPointerCapture(pointerId)
      container!.style.cursor = "grabbing"
      e.preventDefault()
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || e.pointerId !== pointerId) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      commit({ scale: stateRef.current.scale, tx: startTx + dx, ty: startTy + dy })
    }

    function onPointerUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      dragging = false
      try {
        container!.releasePointerCapture(pointerId)
      } catch {
        // Pointer may already be released (e.g. after pointercancel).
      }
      container!.style.cursor = ""
      pointerId = -1
    }

    container.addEventListener("pointerdown", onPointerDown)
    container.addEventListener("pointermove", onPointerMove)
    container.addEventListener("pointerup", onPointerUp)
    container.addEventListener("pointercancel", onPointerUp)
    return () => {
      container.removeEventListener("pointerdown", onPointerDown)
      container.removeEventListener("pointermove", onPointerMove)
      container.removeEventListener("pointerup", onPointerUp)
      container.removeEventListener("pointercancel", onPointerUp)
    }
  }, [containerRef, commit])

  // ── Mobile: two-finger pinch + one-finger pan when zoomed ─────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let pinching = false
    let startDist = 0
    let startMidLocalX = 0
    let startMidLocalY = 0
    let startState: ZoomPanState = IDENTITY

    let panning = false
    let panStartX = 0
    let panStartY = 0
    let panStartTx = 0
    let panStartTy = 0

    function midpoint(t: TouchList, rect: DOMRect): { x: number; y: number; d: number } {
      const x1 = t[0].clientX
      const y1 = t[0].clientY
      const x2 = t[1].clientX
      const y2 = t[1].clientY
      return {
        x: (x1 + x2) / 2 - rect.left,
        y: (y1 + y2) / 2 - rect.top,
        d: Math.hypot(x2 - x1, y2 - y1),
      }
    }

    function onTouchStart(e: TouchEvent) {
      const rect = container!.getBoundingClientRect()
      if (e.touches.length === 2) {
        const m = midpoint(e.touches, rect)
        pinching = true
        panning = false
        startDist = m.d || 1
        startMidLocalX = m.x
        startMidLocalY = m.y
        startState = { ...stateRef.current }
        e.preventDefault()
      } else if (e.touches.length === 1 && isZoomedRef.current) {
        panning = true
        pinching = false
        panStartX = e.touches[0].clientX
        panStartY = e.touches[0].clientY
        panStartTx = stateRef.current.tx
        panStartTy = stateRef.current.ty
        e.stopPropagation() // keep carousel swipe handler from treating this as nav
      }
    }

    function onTouchMove(e: TouchEvent) {
      const rect = container!.getBoundingClientRect()
      if (pinching && e.touches.length === 2) {
        const m = midpoint(e.touches, rect)
        const cw = container!.clientWidth
        const ch = container!.clientHeight
        const cx = cw / 2
        const cy = ch / 2
        const rawScale = startState.scale * (m.d / startDist)
        const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rawScale))
        // Zoom anchored at the *initial* midpoint (Figma-like: point under your fingers stays put),
        // plus pan by the midpoint delta so two-finger drag-during-pinch feels natural.
        const zoomed = zoomToPoint(startState, target, startMidLocalX - cx, startMidLocalY - cy)
        const panDx = m.x - startMidLocalX
        const panDy = m.y - startMidLocalY
        commit({ scale: zoomed.scale, tx: zoomed.tx + panDx, ty: zoomed.ty + panDy })
        e.preventDefault()
      } else if (panning && e.touches.length === 1) {
        const dx = e.touches[0].clientX - panStartX
        const dy = e.touches[0].clientY - panStartY
        commit({ scale: stateRef.current.scale, tx: panStartTx + dx, ty: panStartTy + dy })
        e.preventDefault()
        e.stopPropagation()
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (pinching && e.touches.length < 2) {
        pinching = false
        // Snap back any overshoot / settle elastic bounds.
        commit(stateRef.current, { transition: true })
      }
      if (panning && e.touches.length === 0) {
        panning = false
      }
    }

    container.addEventListener("touchstart", onTouchStart, { passive: false })
    container.addEventListener("touchmove", onTouchMove, { passive: false })
    container.addEventListener("touchend", onTouchEnd)
    container.addEventListener("touchcancel", onTouchEnd)
    return () => {
      container.removeEventListener("touchstart", onTouchStart)
      container.removeEventListener("touchmove", onTouchMove)
      container.removeEventListener("touchend", onTouchEnd)
      container.removeEventListener("touchcancel", onTouchEnd)
    }
  }, [containerRef, commit])

  // ── Double-click / double-tap: toggle zoom ────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function onDblClick(e: MouseEvent) {
      e.preventDefault()
      if (isZoomedRef.current) {
        reset()
      } else {
        const rect = container!.getBoundingClientRect()
        const cx = container!.clientWidth / 2
        const cy = container!.clientHeight / 2
        const px = e.clientX - rect.left - cx
        const py = e.clientY - rect.top - cy
        commit(zoomToPoint(stateRef.current, DOUBLE_ZOOM, px, py), { transition: true })
      }
    }

    // Touch double-tap (manual detection — no dblclick on iOS with touch-action: none).
    let lastTap = 0
    let lastTapX = 0
    let lastTapY = 0
    function onTouchEndTap(e: TouchEvent) {
      if (e.changedTouches.length !== 1) return
      const now = Date.now()
      const t = e.changedTouches[0]
      const dx = t.clientX - lastTapX
      const dy = t.clientY - lastTapY
      const isDouble = now - lastTap < DOUBLE_TAP_MS && Math.hypot(dx, dy) < 30
      if (isDouble) {
        const rect = container!.getBoundingClientRect()
        const localX = t.clientX - rect.left
        const localY = t.clientY - rect.top
        if (isZoomedRef.current) {
          reset()
        } else {
          const cx = container!.clientWidth / 2
          const cy = container!.clientHeight / 2
          commit(zoomToPoint(stateRef.current, DOUBLE_ZOOM, localX - cx, localY - cy), { transition: true })
        }
        lastTap = 0
        e.preventDefault()
      } else {
        lastTap = now
        lastTapX = t.clientX
        lastTapY = t.clientY
      }
    }

    container.addEventListener("dblclick", onDblClick)
    container.addEventListener("touchend", onTouchEndTap)
    return () => {
      container.removeEventListener("dblclick", onDblClick)
      container.removeEventListener("touchend", onTouchEndTap)
    }
  }, [containerRef, commit, reset])

  return {
    isZoomed,
    zoomIn,
    zoomOut,
    reset,
  }
}
