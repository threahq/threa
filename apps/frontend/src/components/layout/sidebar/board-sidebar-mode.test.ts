import { describe, expect, it } from "vitest"
import { isBoardPath } from "./board-sidebar-mode"

describe("isBoardPath", () => {
  it("matches the board pathname (the whole view is query state)", () => {
    expect(isBoardPath("/w/ws_1/board")).toBe(true)
  })

  it("rejects non-board surfaces", () => {
    expect(isBoardPath("/w/ws_1/s/stream_1")).toBe(false)
    expect(isBoardPath("/w/ws_1")).toBe(false)
    expect(isBoardPath("/w/ws_1/saved")).toBe(false)
    expect(isBoardPath("/w/ws_1/boardroom")).toBe(false)
    expect(isBoardPath("/w/ws_1/board/active")).toBe(false)
    expect(isBoardPath("/workspaces")).toBe(false)
  })
})
