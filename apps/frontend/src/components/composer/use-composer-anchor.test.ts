import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useComposerAnchor } from "./use-composer-anchor"

function mount(expanded: boolean, triggerRect: DOMRect) {
  const card = document.createElement("div")
  card.setAttribute("data-composer-card", "")
  if (expanded) card.setAttribute("data-composer-expanded", "true")
  card.getBoundingClientRect = () => new DOMRect(10, 100, 300, 400)
  const trigger = document.createElement("button")
  trigger.getBoundingClientRect = () => triggerRect
  card.append(trigger)
  document.body.append(card)
  return { card, trigger }
}

describe("useComposerAnchor", () => {
  it("anchors the expanded composer's popover to the trigger while it has a box", () => {
    const { card, trigger } = mount(true, new DOMRect(200, 460, 30, 30))
    const { result } = renderHook(() => useComposerAnchor(false))
    act(() => result.current.setTriggerRef(trigger))

    expect(result.current.anchor?.getBoundingClientRect()).toEqual(new DOMRect(10, 460, 300, 0))
    card.remove()
  })

  it("falls back to the card's foot edge when the trigger is folded away (hidden)", () => {
    const { card, trigger } = mount(true, new DOMRect(0, 0, 0, 0))
    const { result } = renderHook(() => useComposerAnchor(false))
    act(() => result.current.setTriggerRef(trigger))

    expect(result.current.anchor?.getBoundingClientRect()).toEqual(new DOMRect(10, 500, 300, 0))
    card.remove()
  })
})
