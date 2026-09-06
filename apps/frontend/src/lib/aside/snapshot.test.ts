import { describe, expect, it } from "vitest"
import { ContextIntents, ContextRefKinds, VIEWPORT_MAX_VISIBLE_IDS } from "@threahq/types"
import { buildAsideBag, buildViewportRef, captureViewportMessageIds, pickVisibleMessageIds } from "./snapshot"
import type { VisibleRow } from "@/lib/timeline/visible-rows"

const BOUNDS = { top: 0, bottom: 100 }

function row(id: string, top: number, bottom: number): VisibleRow {
  return { id, top, bottom }
}

/** A scroller with message rows laid out top to bottom at `rowHeight` each; rect reads are stubbed. */
function mountScroller(
  messageIds: string[],
  opts: { rowHeight: number; viewportHeight: number; composerHeight?: number }
) {
  const scroller = document.createElement("div")
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: opts.viewportHeight }) as DOMRect
  if (opts.composerHeight) scroller.style.setProperty("--composer-height", `${opts.composerHeight}px`)
  messageIds.forEach((id, i) => {
    // Same nesting as the real timeline: the event wrapper (event-item.tsx) and
    // the message element inside it (message-event.tsx) both carry the id.
    const el = document.createElement("div")
    el.dataset.eventId = `event_${id}`
    el.dataset.messageId = id
    const top = i * opts.rowHeight
    el.getBoundingClientRect = () => ({ top, bottom: top + opts.rowHeight }) as DOMRect
    const inner = document.createElement("div")
    inner.dataset.messageId = id
    inner.getBoundingClientRect = () => ({ top, bottom: top + opts.rowHeight }) as DOMRect
    el.appendChild(inner)
    scroller.appendChild(el)
  })
  document.body.appendChild(scroller)
  return scroller
}

describe("pickVisibleMessageIds", () => {
  it("returns the ids intersecting the viewport in viewport (DOM) order", () => {
    const rows = [
      row("msg_a", -80, -10),
      row("msg_b", -5, 30),
      row("msg_c", 30, 70),
      row("msg_d", 95, 140),
      row("msg_e", 140, 200),
    ]
    expect(pickVisibleMessageIds(rows, BOUNDS)).toEqual(["msg_b", "msg_c", "msg_d"])
  })

  it("keeps the bottom-most ids when more than the cap are visible", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`msg_${i}`, i * 10, i * 10 + 10))
    expect(pickVisibleMessageIds(rows, BOUNDS, 4)).toEqual(["msg_2", "msg_3", "msg_4", "msg_5"])
  })

  it("caps at VIEWPORT_MAX_VISIBLE_IDS by default", () => {
    const rows = Array.from({ length: VIEWPORT_MAX_VISIBLE_IDS + 5 }, (_, i) => row(`msg_${i}`, i, i + 1))
    expect(pickVisibleMessageIds(rows, BOUNDS)).toHaveLength(VIEWPORT_MAX_VISIBLE_IDS)
  })
})

describe("captureViewportMessageIds", () => {
  it("yields each message once although wrapper and message element both carry its id", () => {
    const scroller = mountScroller(["msg_1", "msg_2", "msg_3"], { rowHeight: 30, viewportHeight: 100 })
    expect(scroller.querySelectorAll("[data-message-id]")).toHaveLength(6)
    expect(captureViewportMessageIds(scroller)).toEqual(["msg_1", "msg_2", "msg_3"])
    scroller.remove()
  })

  it("reads message rows from the scroller and excludes the band behind the composer", () => {
    const scroller = mountScroller(["msg_1", "msg_2", "msg_3", "msg_4"], {
      rowHeight: 30,
      viewportHeight: 120,
      composerHeight: 40,
    })
    // Rows span 0-30, 30-60, 60-90, 90-120; the composer hides 80-120.
    expect(captureViewportMessageIds(scroller)).toEqual(["msg_1", "msg_2", "msg_3"])
    scroller.remove()
  })
})

describe("buildViewportRef / buildAsideBag", () => {
  it("builds a viewport ref for the host stream from what is on screen", () => {
    const scroller = mountScroller(["msg_1", "msg_2"], { rowHeight: 30, viewportHeight: 100 })
    const ref = buildViewportRef(scroller, "stream_host")
    expect(ref).toMatchObject({
      kind: ContextRefKinds.VIEWPORT,
      streamId: "stream_host",
      visibleMessageIds: ["msg_1", "msg_2"],
    })
    expect(Number.isNaN(Date.parse(ref!.capturedAt))).toBe(false)
    expect(buildAsideBag([ref!])).toEqual({ intent: ContextIntents.ASIDE, refs: [ref] })
    scroller.remove()
  })

  it("returns null when no message row is on screen", () => {
    const scroller = mountScroller([], { rowHeight: 30, viewportHeight: 100 })
    expect(buildViewportRef(scroller, "stream_host")).toBeNull()
    scroller.remove()
  })
})
