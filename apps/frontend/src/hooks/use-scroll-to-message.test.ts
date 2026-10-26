import { describe, it, expect } from "vitest"
import { readHold } from "./use-scroll-to-message"

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

describe("readHold", () => {
  const hold = { id: "msg_held", offsetPx: 120, takenAt: 1000, contentTop: 920 }
  const row = (offsetPx: number) => ({ id: "msg_held", offsetPx })

  it("tells a held row, a reflow above it, and an unstamped scroll apart", () => {
    expect({
      held: readHold(scrollerWithRowAt(120), hold, 500),
      reflow: readHold(scrollerWithRowAt(260), hold, 500),
      reflowWithVirtualizerShift: readHold(scrollerWithRowAt(520, 272), hold, 500),
      scrolled: readHold(scrollerWithRowAt(-340, 1260), hold, 500),
      unlandedSeed: readHold(scrollerWithRowAt(-340, 1260), { ...hold, contentTop: null }, 500),
    }).toEqual({
      held: { state: "held", row: row(120) },
      reflow: { state: "reflowed", row: row(260) },
      reflowWithVirtualizerShift: { state: "reflowed", row: row(520) },
      scrolled: { state: "scrolled" },
      unlandedSeed: { state: "reflowed", row: row(-340) },
    })
  })

  it("voids the hold after a gesture, and when the row unmounts", () => {
    expect({
      gesture: readHold(scrollerWithRowAt(120), hold, 1500),
      unmounted: readHold(document.createElement("div"), hold, 500),
    }).toEqual({ gesture: { state: "void" }, unmounted: { state: "void" } })
  })
})
