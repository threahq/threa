/**
 * True when the touch began on an element that keeps the whole gesture for itself. `touch-action: none` is how a
 * slider, drag handle or pan surface says so, and a swipe owned by one of its ancestors would otherwise run alongside it.
 */
export function startedOnTouchClaimingElement(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node) {
    if (window.getComputedStyle(node).touchAction === "none") return true
    node = node.parentElement
  }
  return false
}
