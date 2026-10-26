import { describe, it, expect } from "vitest"
import { isHoldCurrent } from "./use-scroll-to-message"

function scrollerWithRowAt(rowTop: number, scrollTop = 800): HTMLElement {
  const el = document.createElement("div")
  const row = document.createElement("div")
  row.dataset.messageId = "msg_held"
  el.appendChild(row)
  Object.defineProperty(el, "scrollTop", { value: scrollTop })
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 600 })
  row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100 + rowTop, width: 400, height: 40 })
  return el
}

describe("isHoldCurrent", () => {
  const hold = { id: "msg_held", offsetPx: 120, takenAt: 1000, contentTop: 920 }

  it("holds while the row sits at its held offset and no gesture came after", () => {
    expect(isHoldCurrent(scrollerWithRowAt(120), hold, 500)).toBe(true)
  })

  it("holds through a reflow above the row, even when the virtualizer moved scrollTop with it", () => {
    expect({
      reflow: isHoldCurrent(scrollerWithRowAt(260), hold, 500),
      compensated: isHoldCurrent(scrollerWithRowAt(520, 272), hold, 500),
    }).toEqual({ reflow: true, compensated: true })
  })

  it("lets go once a scroll the gesture stamp never sees moved the row", () => {
    expect(isHoldCurrent(scrollerWithRowAt(-340, 1260), hold, 500)).toBe(false)
  })

  it("keeps an unlanded seed, which has no content position to compare", () => {
    expect(isHoldCurrent(scrollerWithRowAt(-340, 1260), { ...hold, contentTop: null }, 500)).toBe(true)
  })

  it("lets go after a gesture, and when the row unmounts", () => {
    expect({
      gesture: isHoldCurrent(scrollerWithRowAt(120), hold, 1500),
      unmounted: isHoldCurrent(document.createElement("div"), hold, 500),
    }).toEqual({ gesture: false, unmounted: false })
  })
})
