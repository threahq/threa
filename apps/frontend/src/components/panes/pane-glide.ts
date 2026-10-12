import { useLayoutEffect, useRef, type RefObject } from "react"

/** How long panes take to glide into a new arrangement. Edges that track a pane animate over the same time. */
export const PANE_TRANSITION_MS = 240
export const PANE_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)"

const GLIDE = "pane-glide"
const TOUCH = 2

interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface Neighbour {
  /** The neighbour in the arrangement the box is measured in. */
  beside: Box
  /** The neighbour in the other arrangement: the box opens from, or shuts at, its edge there. */
  at: Box
}

const px = (value: number) => `${value}px`
const touches = (a: number, b: number) => Math.abs(a - b) <= TOUCH
const sameBox = (a: Box, b: Box) =>
  touches(a.left, b.left) && touches(a.top, b.top) && touches(a.width, b.width) && touches(a.height, b.height)
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
const isPane = (element: Element) => element.hasAttribute("data-panel-tab")

function boxOf(element: Element, origin: DOMRect): Box {
  const rect = element.getBoundingClientRect()
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
}

/** The host's grid children by their boxes, with any glide still running cancelled so the boxes are laid-out ones. */
function measure(host: HTMLElement): Map<Element, Box> {
  const origin = host.getBoundingClientRect()
  const boxes = new Map<Element, Box>()
  for (const child of host.children) {
    // A floating pane is fixed in the shell's box, and a folding one is on its way out.
    if (child.hasAttribute("data-focused-pane") || child.hasAttribute("data-pane-fold")) continue
    for (const target of [child, child.firstElementChild]) {
      target?.getAnimations().forEach((animation) => animation.id === GLIDE && animation.cancel())
    }
    boxes.set(child, boxOf(child, origin))
  }
  return boxes
}

/**
 * `box` shut against the neighbour that takes (or gave) its space, at that
 * neighbour's edge in the other arrangement: the two edges stay glued while
 * one grows and the other folds. With no such neighbour it shuts in place.
 */
function shut(box: Box, neighbours: readonly Neighbour[]): Box {
  const into = neighbours
    .map((neighbour) => ({ ...neighbour, area: overlap(box, neighbour.at) }))
    .filter((neighbour) => neighbour.area > 0)
    .sort((a, b) => b.area - a.area)[0]
  if (!into) return { ...box, width: 0 }
  const { beside, at } = into
  if (touches(beside.left + beside.width, box.left)) return { ...box, left: at.left + at.width, width: 0 }
  if (touches(beside.left, box.left + box.width)) return { ...box, left: at.left, width: 0 }
  if (touches(beside.top + beside.height, box.top)) return { ...box, top: at.top + at.height, height: 0 }
  if (touches(beside.top, box.top + box.height)) return { ...box, top: at.top, height: 0 }
  return { ...box, width: 0 }
}

const LIFT = "0 12px 32px rgba(0, 0, 0, 0.24)"
const NO_LIFT = "0 0 0 rgba(0, 0, 0, 0)"

/** Glides `element` from the box `from` to `to`, the box its layout gives it, its content held at the final size throughout. */
function travel(element: Element, from: Box, to: Box, options: KeyframeAnimationOptions) {
  // Lifted over the others on a move that clears its own old box, so it travels on top and never under a neighbour.
  const lifted = isPane(element) && overlap(from, to) === 0
  const appearing = from.width === 0 || from.height === 0
  const start: Keyframe = {
    transform: `translate(${px(from.left - to.left)}, ${px(from.top - to.top)})`,
    width: px(from.width),
    height: px(from.height),
  }
  const end: Keyframe = { transform: "none", width: px(to.width), height: px(to.height) }
  const frames = [start, end]
  if (appearing) {
    start.opacity = 0
    frames.splice(1, 0, { opacity: 1, offset: 0.5 })
  }
  if (lifted) {
    start.zIndex = end.zIndex = 2
    start.boxShadow = end.boxShadow = NO_LIFT
    frames.splice(1, 0, { boxShadow: LIFT, offset: 0.5 })
  }
  element.animate(frames, options)
  if (isPane(element)) {
    const held: Keyframe = { width: px(to.width), height: px(to.height) }
    element.firstElementChild?.animate([held, held], options)
  }
}

/**
 * Folds the pane React has just unmounted: its own node, put back in the host
 * as an inert absolutely positioned box at `from`, that shuts to `to` and is
 * removed. Its scrollers are set back to where they were, as a box out of the
 * document loses its offsets.
 */
function fold(
  host: HTMLElement,
  pane: Element,
  from: Box,
  to: Box,
  scrolls: WeakMap<Element, { top: number; left: number }>,
  options: KeyframeAnimationOptions
) {
  if (!(pane instanceof HTMLElement)) return
  // A fold is scenery: nothing finds it by test id, id or tab, reads it, or reaches it.
  for (const marked of [pane, ...pane.querySelectorAll("[data-testid], [id]")]) {
    marked.removeAttribute("data-testid")
    marked.removeAttribute("id")
  }
  for (const attribute of ["data-panel-tab", "data-front-panel"]) pane.removeAttribute(attribute)
  pane.setAttribute("data-pane-fold", "")
  pane.setAttribute("aria-hidden", "true")
  pane.setAttribute("inert", "")
  Object.assign(pane.style, {
    position: "absolute",
    gridArea: "auto",
    left: px(from.left),
    top: px(from.top),
    width: px(from.width),
    height: px(from.height),
    zIndex: "1",
    pointerEvents: "none",
  })
  const inner = pane.firstElementChild
  if (inner instanceof HTMLElement) Object.assign(inner.style, { width: px(from.width), height: px(from.height) })
  host.appendChild(pane)
  for (const scroller of pane.querySelectorAll("*")) {
    const offset = scrolls.get(scroller)
    if (offset) {
      scroller.scrollTop = offset.top
      scroller.scrollLeft = offset.left
    }
  }
  const animation = pane.animate(
    [
      { left: px(from.left), top: px(from.top), width: px(from.width), height: px(from.height), opacity: 1 },
      { left: px(to.left), top: px(to.top), width: px(to.width), height: px(to.height), opacity: 0 },
    ],
    options
  )
  animation.onfinish = animation.oncancel = () => pane.remove()
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Glides the host's panes from the boxes they had into the ones a new
 * arrangement gives them (FLIP on the Web Animations API), on the commits
 * `glide` marks. The grid itself jumps to its final tracks, so React, layout
 * and every measurement see the arrangement at once; only the paint lags. A
 * pane the arrangement adds opens from the edge of the pane whose space it
 * takes, one it drops folds shut at the edge of the pane that takes its space,
 * and a pane replacing another in the same box, or joining a stack, just
 * appears. Under reduced motion, or without the API, every change cuts.
 */
export function usePaneGlide(host: RefObject<HTMLDivElement | null>, glide: boolean) {
  const boxes = useRef(new Map<Element, Box>())
  const scrolls = useRef(new WeakMap<Element, { top: number; left: number }>())

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const remember = (event: Event) => {
      const scroller = event.target
      if (scroller instanceof Element)
        scrolls.current.set(scroller, { top: scroller.scrollTop, left: scroller.scrollLeft })
    }
    element.addEventListener("scroll", remember, true)
    return () => element.removeEventListener("scroll", remember, true)
  }, [host])

  useLayoutEffect(() => {
    const element = host.current
    if (!element || typeof element.animate !== "function") return
    const before = boxes.current
    const now = measure(element)
    boxes.current = now
    if (!glide || before.size === 0 || reducedMotion()) return

    const options: KeyframeAnimationOptions = { duration: PANE_TRANSITION_MS, easing: PANE_EASING, id: GLIDE }
    const survivors = [...now]
      .filter(([child]) => before.has(child))
      .map(([child, box]) => ({ child, was: before.get(child)!, box }))
    for (const { child, was, box } of survivors) {
      if (!sameBox(was, box)) travel(child, was, box, options)
    }
    for (const [child, box] of now) {
      if (before.has(child)) continue
      if (!isPane(child)) {
        child.animate([{ opacity: 0 }, { opacity: 1 }], options)
        continue
      }
      if ([...before.values()].some((was) => sameBox(was, box))) continue
      travel(
        child,
        shut(
          box,
          survivors.map(({ was, box }) => ({ beside: box, at: was }))
        ),
        box,
        options
      )
    }
    for (const [child, was] of before) {
      if (now.has(child) || child.isConnected || !isPane(child)) continue
      if ([...now.values()].some((box) => sameBox(was, box))) continue
      fold(
        element,
        child,
        was,
        shut(
          was,
          survivors.map(({ was, box }) => ({ beside: was, at: box }))
        ),
        scrolls.current,
        options
      )
    }
  })
}
