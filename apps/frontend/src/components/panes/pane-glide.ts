import { useLayoutEffect, useRef, type RefObject } from "react"

/** How long panes take to glide into a new arrangement. Edges that track a pane animate over the same time. */
export const PANE_TRANSITION_MS = 240
export const PANE_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)"

const GLIDE = "pane-glide"
/** The glide's progress, 0 at the boxes the panes had and 1 at the ones they have (`@property` in index.css). */
const PROGRESS = "--pane-glide"
const GLIDING = "data-pane-gliding"
const FOLD = "data-pane-fold"
const TOUCH = 2

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const px = (value: number) => `${value}px`
/** `at` scaled by how far the glide has to go: all of it at the start, none at the end. */
const togo = (at: number) => `calc(${px(at)} * (1 - var(${PROGRESS})))`
const touches = (a: number, b: number) => Math.abs(a - b) <= TOUCH
const sameBox = (a: Box, b: Box) =>
  touches(a.left, b.left) && touches(a.top, b.top) && touches(a.width, b.width) && touches(a.height, b.height)
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
const isPane = (element: Element) => element.hasAttribute("data-panel-tab")
const isDivider = (element: Element) => element.getAttribute("role") === "separator"
const inGlide = (element: Element) => element.hasAttribute(GLIDING) || element.hasAttribute(FOLD)

function boxOf(element: Element, origin: DOMRect): Box {
  const rect = element.getBoundingClientRect()
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
}

/** The one animation driving the host's glide, when one runs. */
const driver = (host: Element) => host.getAnimations().find((animation) => animation.id === GLIDE)

/** Takes `child` out of the glide, its box the laid-out one again. */
function release(child: Element) {
  if (!(child instanceof HTMLElement) || !child.hasAttribute(GLIDING)) return
  child.removeAttribute(GLIDING)
  child.style.removeProperty(PROGRESS)
  child.style.zIndex = ""
  // Only what the glide wrote: React sets a floating pane's width in the commit that floats it mid-glide.
  for (const property of ["transform", "width", "height", "boxShadow"] as const) {
    if (child.style[property].includes(PROGRESS)) child.style[property] = ""
  }
}

/** Lands the glide: every child it set gliding is at its laid-out box, and those it kept on show for it go. */
function settle(host: HTMLElement) {
  for (const child of [...host.children]) {
    if (child.hasAttribute(FOLD)) child.remove()
    else release(child)
  }
}

/**
 * The host's grid children on show by their boxes, with any glide still running cut short: settled so the
 * boxes are laid-out ones.
 */
function measure(host: HTMLElement): Map<Element, Box> {
  driver(host)?.cancel()
  settle(host)
  const origin = host.getBoundingClientRect()
  const boxes = new Map<Element, Box>()
  for (const child of host.children) {
    // A floating pane is fixed in the shell's box.
    if (child.hasAttribute("data-focused-pane")) continue
    // A tab under another in its section is laid out but not on show, so the change that uncovers it adds it.
    if (getComputedStyle(child).visibility === "hidden") continue
    boxes.set(child, boxOf(child, origin))
  }
  return boxes
}

/**
 * Where a pane paints while the panes glide: the ones that move over the ones that hold still, so a
 * growing pane covers the one that closed. One the arrangement adds opens between its neighbours' edges.
 */
const CLOSED = 0
const ADDED = 1
const MOVING = 2
const LIFTED = 3

/** A shadow under a lifted pane that rises to the glide's midpoint and settles by its end. */
const RISE = `calc(2 * min(var(${PROGRESS}), 1 - var(${PROGRESS})))`
const LIFT = `0 calc(12px * ${RISE}) calc(32px * ${RISE}) rgba(0, 0, 0, calc(0.24 * ${RISE}))`

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
 * Where the pane laid out at `pane` opens from: each side where the divider along it starts out, so the pane
 * grows out of the edges that part it from its neighbours and covers none of them. A side with no divider
 * along it (the host's edge) holds still. `dividers` are each divider's box at the pane's end and at the other.
 */
function opening(pane: Box, dividers: readonly (readonly [Box, Box])[]): Box {
  const sides = { left: pane.left, top: pane.top, right: pane.left + pane.width, bottom: pane.top + pane.height }
  const from = { ...sides }
  for (const [here, there] of dividers) {
    const upright = here.height > here.width
    const [start, length, place, size] = upright
      ? (["top", "height", "left", "width"] as const)
      : (["left", "width", "top", "height"] as const)
    const [before, after] = upright ? (["left", "right"] as const) : (["top", "bottom"] as const)
    if (here[start] + here[length] <= pane[start] || pane[start] + pane[length] <= here[start]) continue
    if (touches(here[place] + here[size], sides[before])) from[before] = there[place] + there[size]
    else if (touches(here[place], sides[after])) from[after] = there[place]
  }
  return {
    left: Math.min(from.left, from.right),
    top: Math.min(from.top, from.bottom),
    width: Math.max(0, from.right - from.left),
    height: Math.max(0, from.bottom - from.top),
  }
}

/**
 * Sets `element` gliding from the box `from` to `to`, the box its layout gives it: its offset and size are
 * written as what the glide's progress leaves of the difference, so every gliding edge is read off the one
 * progress in the same style pass and none can run ahead of another. A pane's content is sized to the gliding
 * box on every frame, as on a divider drag. A pane takes `layer` when given, or one by how far it moves.
 */
function travel(element: Element, from: Box, to: Box, layer?: number) {
  if (!(element instanceof HTMLElement)) return
  // The progress is not inherited, so a glide restyles the gliding boxes and not their subtrees.
  element.style.setProperty(PROGRESS, "inherit")
  element.style.transform = `translate(${togo(from.left - to.left)}, ${togo(from.top - to.top)})`
  element.style.width = `calc(${px(to.width)} + ${togo(from.width - to.width)})`
  element.style.height = `calc(${px(to.height)} + ${togo(from.height - to.height)})`
  if (isPane(element)) {
    // Lifted over the others on a move that clears its own old box, so it travels on top and never under a neighbour.
    const lifted = layer === undefined && overlap(from, to) === 0
    element.style.zIndex = String(layer ?? (lifted ? LIFTED : MOVING))
    if (lifted) element.style.boxShadow = LIFT
  }
  element.setAttribute(GLIDING, "")
}

/**
 * Keeps the node React has just unmounted on show for the glide: put back in the host as an inert
 * absolutely positioned box at `at`, and removed when the glide lands or the measure that cuts it short.
 */
function keep(host: HTMLElement, node: HTMLElement, at: Box) {
  node.setAttribute(FOLD, "")
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
  scrolls: WeakMap<Element, { top: number; left: number }>
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
}

/**
 * Settles once no glide moves the pane holding `element`, waiting out any glide that starts before the
 * running one lands; null when none is running.
 */
export function paneLanding(element: Element): Promise<void> | null {
  const host = element.closest("[data-panel-tab]")?.parentElement
  if (!host || typeof host.getAnimations !== "function") return null
  const pane = element.closest("[data-panel-tab]")!
  const land = async (running: Animation): Promise<void> => {
    await running.finished.catch(() => undefined)
    const next = driver(host)
    if (next && pane.hasAttribute(GLIDING)) return land(next)
  }
  const running = driver(host)
  return running && pane.hasAttribute(GLIDING) ? land(running) : null
}

/** Whether the device asks for motion to be cut; every edge that would glide snaps then. */
export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Glides the host's panes from the boxes they had into the ones a new
 * arrangement gives them (FLIP on the Web Animations API), on the commits
 * `glide` marks. The grid itself jumps to its final tracks, so React sees the
 * arrangement at once. One animation drives a glide, the host's `--pane-glide`
 * progress, and every gliding box is a function of it: the panes that were
 * there move, each laid out at its gliding size until it lands; a pane the
 * arrangement adds opens out of the dividers that part it from them, its edges
 * on theirs; one it drops holds still while they grow over it, unless another
 * pane takes its box; a divider the arrangement adds or drops travels with the
 * edge it marks. Without the API, or registered properties, every change cuts.
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
    if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return
    // A commit that keeps the arrangement (a focus, a store update) within the 240ms leaves the glide
    // running and the boxes it set out for standing; measuring here would cancel it mid-flight. A
    // resize among them moves where it ends, so the boxes are read again once it has.
    // A pane floated mid-glide leaves it, or the glide's layer and size hold it under the scrim it floats over.
    for (const child of element.children) if (child.hasAttribute("data-focused-pane")) release(child)
    const running = driver(element)
    if (!glide && running) {
      void running.finished.then(
        () => {
          if (!driver(element)) boxes.current = measure(element)
        },
        () => undefined
      )
      return
    }
    const before = boxes.current
    const now = measure(element)
    boxes.current = now
    if (!glide || before.size === 0) return

    // The panes on show at both ends, each as the box it had and the one it has.
    const staying = [...now].flatMap(([child, box]) => {
      const was = before.get(child)
      return was && isPane(child) ? [[was, box] as const] : []
    })
    const added: [Element, Box][] = []
    // Each divider on show at the arrangement's end, as its box there and the one it glides from.
    const dividers: (readonly [Box, Box])[] = []
    for (const [child, box] of now) {
      const was = before.get(child)
      if (was) {
        if (isDivider(child)) dividers.push([box, was])
        if (!sameBox(was, box)) travel(child, was, box)
        continue
      }
      if (isDivider(child)) {
        const replaces = [...before].some(([other, stood]) => !other.isConnected && sameBox(stood, box))
        const from = replaces
          ? null
          : across(
              box,
              staying.map(([stood, stands]) => [stands, stood] as const)
            )
        dividers.push([box, from ?? box])
        if (from && !sameBox(from, box)) travel(child, from, box)
        continue
      }
      if (isPane(child)) added.push([child, box])
    }
    for (const [child, was] of before) {
      if (now.has(child) || child.isConnected || !(child instanceof HTMLElement)) continue
      if ([...now.values()].some((box) => sameBox(was, box))) continue
      if (isPane(child)) fold(element, child, was, scrolls.current)
      const to = isDivider(child) ? across(was, staying) : null
      if (!to || sameBox(was, to)) continue
      keep(element, child, to)
      travel(child, was, to)
    }
    // A pane arriving where nothing moves (a stream switch) shows at once; one arriving amid a glide takes its own
    // layer for it, or what it stacks inside (a load mask, a composer) paints over the panes above it.
    const moving = [...element.children].some(inGlide)
    for (const [child, box] of added) {
      const from = opening(box, dividers)
      if (!sameBox(from, box)) travel(child, from, box, ADDED)
      else if (moving && child instanceof HTMLElement) {
        child.style.zIndex = String(ADDED)
        child.setAttribute(GLIDING, "")
      }
    }
    if (![...element.children].some(inGlide)) return
    element
      .animate([{ [PROGRESS]: "0" }, { [PROGRESS]: "1" }], {
        duration: PANE_TRANSITION_MS,
        easing: PANE_EASING,
        id: GLIDE,
      })
      .finished.then(
        () => settle(element),
        () => undefined
      )
  })
}
