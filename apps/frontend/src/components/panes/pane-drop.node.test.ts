import { describe, expect, it } from "vitest"
import { paneDropZoneAt } from "./pane-drop"

const box = { left: 100, top: 0, width: 400, height: 800 }
const ALL = ["left", "right", "top", "bottom"] as const

describe("paneDropZoneAt", () => {
  it("should pick the nearest offered edge within its band, else the centre", () => {
    expect([
      paneDropZoneAt(box, 120, 400, ALL),
      paneDropZoneAt(box, 490, 400, ALL),
      paneDropZoneAt(box, 300, 20, ALL),
      paneDropZoneAt(box, 300, 790, ALL),
      paneDropZoneAt(box, 300, 400, ALL),
      paneDropZoneAt(box, 110, 10, ALL),
    ]).toEqual(["left", "right", "top", "bottom", "centre", "top"])
  })

  it("should read an edge that isn't offered as the centre", () => {
    expect([
      paneDropZoneAt(box, 120, 400, ["top", "bottom"]),
      paneDropZoneAt(box, 490, 400, ["right"]),
      paneDropZoneAt(box, 300, 20, []),
    ]).toEqual(["centre", "right", "centre"])
  })
})
