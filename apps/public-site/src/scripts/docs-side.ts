/*
 * Docs sidebar: a draggable width that survives reloads, and the full text of a
 * truncated entry on hover.
 */

import { SIDE_WIDTH } from "../lib/docs-side-width"

const clampWidth = (w: number) => Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, w)))

function bindResize(): void {
  const handle = document.getElementById("docs-side-resize")
  const side = document.getElementById("docs-side")
  if (!handle || !side) return
  const root = document.documentElement

  const apply = (w: number) => {
    root.style.setProperty("--docs-side-w", `${w}px`)
    handle.setAttribute("aria-valuenow", String(w))
  }
  const save = (w: number) => {
    try {
      localStorage.setItem(SIDE_WIDTH.storageKey, String(w))
    } catch {
      /* private mode: the width just won't persist */
    }
  }
  const current = () => clampWidth(side.getBoundingClientRect().width)
  handle.setAttribute("aria-valuenow", String(current()))

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = side.getBoundingClientRect().width
    let next = clampWidth(startW)
    let frame = 0
    document.body.classList.add("docs-resizing")

    // Pointer events can outpace the display; write the width once per frame.
    const move = (ev: PointerEvent) => {
      next = clampWidth(startW + ev.clientX - startX)
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          apply(next)
        })
    }
    const end = () => {
      cancelAnimationFrame(frame)
      apply(next)
      save(next)
      document.body.classList.remove("docs-resizing")
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  })

  handle.addEventListener("keydown", (e) => {
    const w = current()
    const targets: Record<string, number> = {
      ArrowLeft: w - SIDE_WIDTH.step,
      ArrowRight: w + SIDE_WIDTH.step,
      Home: SIDE_WIDTH.min,
      End: SIDE_WIDTH.max,
    }
    if (!(e.key in targets)) return
    e.preventDefault()
    const next = clampWidth(targets[e.key])
    apply(next)
    save(next)
  })

  handle.addEventListener("dblclick", () => {
    root.style.removeProperty("--docs-side-w")
    try {
      localStorage.removeItem(SIDE_WIDTH.storageKey)
    } catch {
      /* nothing stored to clear */
    }
    handle.setAttribute("aria-valuenow", String(current()))
  })
}

/* A truncated entry shows its full text in a label laid exactly over it, so
   the text doesn't move, it just continues past the sidebar's edge. */
function bindTruncatedTips(): void {
  const side = document.getElementById("docs-side")
  if (!side || !matchMedia("(hover: hover)").matches) return
  const TRUNCATES = "a, h4, .dss-group-head > span"

  const tip = document.createElement("div")
  tip.className = "docs-side-tip"
  tip.setAttribute("aria-hidden", "true")
  tip.hidden = true
  document.body.append(tip)
  let shown: HTMLElement | null = null

  const hide = () => {
    tip.hidden = true
    shown = null
  }
  const show = (el: HTMLElement) => {
    if (el.scrollWidth <= el.clientWidth) return
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const inset = parseFloat(cs.borderLeftWidth) || 0
    tip.textContent = el.textContent?.trim() ?? ""
    Object.assign(tip.style, {
      font: cs.font,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      left: `${r.left + inset - 1}px`,
      top: `${r.top - 1}px`,
    })
    tip.hidden = false
    shown = el
  }
  const target = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(TRUNCATES)

  side.addEventListener("pointerover", (e) => {
    const el = target(e)
    if (el === shown) return
    hide()
    if (el && !document.body.classList.contains("docs-resizing")) show(el)
  })
  side.addEventListener("pointerleave", hide)
  side.addEventListener("scroll", hide, { passive: true })
  side.addEventListener("focusin", (e) => {
    const el = target(e)
    if (el?.matches(":focus-visible")) show(el)
  })
  side.addEventListener("focusout", hide)
  window.addEventListener("resize", hide)
  document.addEventListener("pointerdown", hide)
}

bindResize()
bindTruncatedTips()
