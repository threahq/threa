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

const px = (value: number) => `${value}px`
const touches = (a: number, b: number) => Math.abs(a - b) <= TOUCH
const sameBox = (a: Box, b: Box) =>
  touches(a.left, b.left) && touches(a.top, b.top) && touches(a.width, b.width) && touches(a.height, b.height)
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
const isPane = (element: Element) => element.hasAttribute("data-panel-tab")
const isDivider = (element: Element) => element.getAttribute("role") === "separator"

function boxOf(element: Element, origin: DOMRect): Box {
  const rect = element.getBoundingClientRect()
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
}

const cut = (child: Element) =>
  child.getAnimations().forEach((animation) => animation.id === GLIDE && animation.cancel())

/**
 * The host's grid children on show by their boxes, with any glide still running cut short: its
 * animations cancelled so the boxes are laid-out ones, and the panes and dividers it kept on show removed.
 */
function measure(host: HTMLElement): Map<Element, Box> {
  const origin = host.getBoundingClientRect()
  const boxes = new Map<Element, Box>()
  for (const child of [...host.children]) {
    if (child.hasAttribute("data-pane-fold")) {
      child.remove()
      continue
    }
    // A floating pane is fixed in the shell's box.
    if (child.hasAttribute("data-focused-pane")) continue
    cut(child)
    // A tab under another in its section is laid out but not on show, so the change that uncovers it adds it.
    if (getComputedStyle(child).visibility === "hidden") continue
    boxes.set(child, boxOf(child, origin))
  }
  return boxes
}

/**
 * Where a pane paints while the panes glide: the ones that move over the ones that hold still, so a
 * shrinking pane uncovers the one added beside it and a growing one covers the one that closed.
 */
const CLOSED = 0
const ADDED = 1
const MOVING = 2
const LIFTED = 3

const LIFT = "0 12px 32px rgba(0, 0, 0, 0.24)"
const NO_LIFT = "0 0 0 rgba(0, 0, 0, 0)"

/**
 * Where `divider` stands at the other end of the glide. A divider is the edge of the panes either side of it,
 * so it goes where a pane on show at both ends takes that edge, the pane after it first, and with the whole of
 * that pane's side where it runs the length of it. `panes` are those panes, each as its box at the divider's
 * end and at the other. Null where neither pane beside it is on show at both.
 */
function across(divider: Box, panes: readonly (readonly [Box, Box])[]): Box | null {
  const upright = divider.height > divider.width
  // The divider's place across the panes it parts, and its reach along them.
  const [place, size, start, length] = upright
    ? (["left", "width", "top", "height"] as const)
    : (["top", "height", "left", "width"] as const)
  for (const trailing of [true, false]) {
    for (const [here, there] of panes) {
      if (divider[start] + divider[length] <= here[start] || here[start] + here[length] <= divider[start]) continue
      if (!touches(divider[place], here[place] + (trailing ? 0 : here[size]))) continue
      const moved = { ...divider, [place]: there[place] + (trailing ? 0 : there[size]) }
      const alongside = touches(divider[start], here[start]) && touches(divider[length], here[length])
      return alongside ? { ...moved, [start]: there[start], [length]: there[length] } : moved
    }
  }
  return null
}

/**
 * Glides `element` from the box `from` to `to`, the box its layout gives it. A pane's content is sized to
 * the gliding box on every frame, as on a divider drag, so it moves with its edges and never jumps ahead.
 */
function travel(element: Element, from: Box, to: Box, options: KeyframeAnimationOptions): Animation {
  const start: Keyframe = {
    transform: `translate(${px(from.left - to.left)}, ${px(from.top - to.top)})`,
    width: px(from.width),
    height: px(from.height),
  }
  const end: Keyframe = { transform: "none", width: px(to.width), height: px(to.height) }
  const frames = [start, end]
  if (isPane(element)) {
    // Lifted over the others on a move that clears its own old box, so it travels on top and never under a neighbour.
    const lifted = overlap(from, to) === 0
    start.zIndex = end.zIndex = lifted ? LIFTED : MOVING
    if (lifted) {
      start.boxShadow = end.boxShadow = NO_LIFT
      frames.splice(1, 0, { boxShadow: LIFT, offset: 0.5 })
    }
  }
  return element.animate(frames, options)
}

/**
 * Keeps the node React has just unmounted on show for the glide: put back in the host as an inert
 * absolutely positioned box at `at`, and removed by the glide that kept it or the measure that cuts it short.
 */
function keep(host: HTMLElement, node: HTMLElement, at: Box) {
  node.setAttribute("data-pane-fold", "")
  node.setAttribute("aria-hidden", "true")
  node.setAttribute("inert", "")
  Object.assign(node.style, {
    position: "absolute",
    gridArea: "auto",
    left: px(at.left),
    top: px(at.top),
    width: px(at.width),
    height: px(at.height),
    pointerEvents: "none",
  })
  host.appendChild(node)
}

/**
 * Holds the pane the arrangement dropped still at `from`, under the panes growing over it, until they
 * have. Its scrollers are set back to where they were, as a box out of the document loses its offsets.
 */
function fold(
  host: HTMLElement,
  pane: HTMLElement,
  from: Box,
  scrolls: WeakMap<Element, { top: number; left: number }>,
  options: KeyframeAnimationOptions
) {
  // A fold is scenery: nothing finds it by test id, id, tab, scroller or message, reads it, or reaches it.
  const marks = ["data-testid", "id", "data-stream-scroller", "data-message-id"]
  for (const marked of [pane, ...pane.querySelectorAll(marks.map((mark) => `[${mark}]`).join(","))]) {
    for (const mark of marks) marked.removeAttribute(mark)
  }
  for (const attribute of ["data-panel-tab", "data-front-panel"]) pane.removeAttribute(attribute)
  pane.style.zIndex = String(CLOSED)
  keep(host, pane, from)
  for (const scroller of pane.querySelectorAll("*")) {
    const offset = scrolls.get(scroller)
    if (offset) {
      scroller.scrollTop = offset.top
      scroller.scrollLeft = offset.left
    }
  }
  pane.animate(null, options).onfinish = () => pane.remove()
}

/** Whether the device asks for motion to be cut; every edge that would glide snaps then. */
export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Glides the host's panes from the boxes they had into the ones a new
 * arrangement gives them (FLIP on the Web Animations API), on the commits
 * `glide` marks. The grid itself jumps to its final tracks, so React sees the
 * arrangement at once. The panes that were there are the ones that move, each
 * laid out at its gliding size until it lands: a pane the arrangement adds
 * holds still where it lands while they uncover it, and one it drops holds
 * still while they grow over it, unless another pane takes its box. A divider
 * the arrangement adds or drops travels with the edge it marks. Without the
 * API every change cuts.
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
    // A commit that keeps the arrangement (a focus, a store update) within the 240ms leaves the glide
    // running and the boxes it set out for standing; measuring here would cancel it mid-flight. A
    // resize among them moves where it ends, so the boxes are read again once it has.
    // A pane floated mid-glide leaves it, or the glide's layer and size hold it under the scrim it floats over.
    for (const child of element.children) if (child.hasAttribute("data-focused-pane")) cut(child)
    const running = element.getAnimations({ subtree: true }).filter((animation) => animation.id === GLIDE)
    if (!glide && running.length > 0) {
      void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
        if (!element.getAnimations({ subtree: true }).some((animation) => animation.id === GLIDE)) {
          boxes.current = measure(element)
        }
      })
      return
    }
    const before = boxes.current
    const now = measure(element)
    boxes.current = now
    if (!glide || before.size === 0) return

    const options: KeyframeAnimationOptions = { duration: PANE_TRANSITION_MS, easing: PANE_EASING, id: GLIDE }
    // The panes on show at both ends, each as the box it had and the one it has.
    const staying = [...now].flatMap(([child, box]) => {
      const was = before.get(child)
      return was && isPane(child) ? [[was, box] as const] : []
    })
    for (const [child, box] of now) {
      const was = before.get(child)
      if (was) {
        if (!sameBox(was, box)) travel(child, was, box, options)
        continue
      }
      if (isDivider(child)) {
        if ([...before].some(([other, stood]) => !other.isConnected && sameBox(stood, box))) continue
        const from = across(
          box,
          staying.map(([stood, stands]) => [stands, stood] as const)
        )
        if (from && !sameBox(from, box)) travel(child, from, box, options)
        continue
      }
      // Its own layer for the glide, or what it stacks inside (a load mask, a composer) paints over the panes above it.
      if (isPane(child)) child.animate([{ zIndex: ADDED }, { zIndex: ADDED }], options)
    }
    for (const [child, was] of before) {
      if (now.has(child) || child.isConnected || !(child instanceof HTMLElement)) continue
      if ([...now.values()].some((box) => sameBox(was, box))) continue
      if (isPane(child)) fold(element, child, was, scrolls.current, options)
      const to = isDivider(child) ? across(was, staying) : null
      if (!to || sameBox(was, to)) continue
      keep(element, child, to)
      travel(child, was, to, options).onfinish = () => child.remove()
    }
  })
}
