import { describe, expect, it } from "vitest"
import { isBoardPath } from "./board-sidebar-mode"

describe("isBoardPath", () => {
  it("matches the bare board and lens-segmented board URLs", () => {
    expect(isBoardPath("/w/ws_1/board")).toBe(true)
    expect(isBoardPath("/w/ws_1/board/active")).toBe(true)
    expect(isBoardPath("/w/ws_1/board/needs-resolution")).toBe(true)
  })

  it("rejects non-board surfaces", () => {
    expect(isBoardPath("/w/ws_1/s/stream_1")).toBe(false)
    expect(isBoardPath("/w/ws_1")).toBe(false)
    expect(isBoardPath("/w/ws_1/saved")).toBe(false)
    expect(isBoardPath("/w/ws_1/boardroom")).toBe(false)
    expect(isBoardPath("/w/ws_1/board/active/extra")).toBe(false)
    expect(isBoardPath("/workspaces")).toBe(false)
  })
})
