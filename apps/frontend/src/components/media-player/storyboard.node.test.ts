import { describe, it, expect } from "vitest"
import { storyboardTileStyle } from "./storyboard"

const storyboard = {
  status: "ready",
  columns: 10,
  rows: 3,
  tileCount: 24,
  intervalMs: 500,
  tileWidth: 240,
  tileHeight: 180,
} as const
const tile = { width: 160, height: 120 }

describe("storyboardTileStyle", () => {
  it("picks the tile whose interval holds the time, row-major", () => {
    expect({
      start: storyboardTileStyle(storyboard, 0, tile),
      intervalEnd: storyboardTileStyle(storyboard, 0.499, tile),
      midRow: storyboardTileStyle(storyboard, 6.2, tile),
      last: storyboardTileStyle(storyboard, 11.9, tile),
      pastEnd: storyboardTileStyle(storyboard, 60, tile),
      beforeStart: storyboardTileStyle(storyboard, -1, tile),
    }).toEqual({
      start: { backgroundSize: "1600px 360px", backgroundPosition: "0px 0px" },
      intervalEnd: { backgroundSize: "1600px 360px", backgroundPosition: "0px 0px" },
      midRow: { backgroundSize: "1600px 360px", backgroundPosition: "-320px -120px" },
      last: { backgroundSize: "1600px 360px", backgroundPosition: "-480px -240px" },
      pastEnd: { backgroundSize: "1600px 360px", backgroundPosition: "-480px -240px" },
      beforeStart: { backgroundSize: "1600px 360px", backgroundPosition: "0px 0px" },
    })
  })
})
