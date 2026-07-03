import { describe, it, expect } from "vitest"
import { rowReadState, type ReadFrontier } from "./read-frontier-context"

const EMPTY: ReadonlySet<string> = new Set()
const frontier = (sequence: string | null, overlay: ReadonlySet<string> = EMPTY): ReadFrontier => ({
  sequence,
  overlay,
})

describe("rowReadState", () => {
  it("is ungated when there is no frontier (unresolved / out-of-window) and not overlay-read", () => {
    expect(rowReadState("5", "msg_1", frontier(null))).toBe("ungated")
  })

  it("is ungated when the row has no sequence yet (optimistic send) and not overlay-read", () => {
    expect(rowReadState(undefined, "msg_1", frontier("5"))).toBe("ungated")
    expect(rowReadState(null, "msg_1", frontier("5"))).toBe("ungated")
  })

  it("is unread when the row sits strictly past the frontier", () => {
    expect(rowReadState("6", "msg_1", frontier("5"))).toBe("unread")
  })

  it("is read at or before the frontier (the frontier row is the last read)", () => {
    expect(rowReadState("5", "msg_1", frontier("5"))).toBe("read")
    expect(rowReadState("4", "msg_1", frontier("5"))).toBe("read")
  })

  it("treats a '0' frontier (nothing read) as everything unread", () => {
    expect(rowReadState("1", "msg_1", frontier("0"))).toBe("unread")
  })

  it("compares as integers, not lexically (large sequences)", () => {
    expect(rowReadState("100", "msg_1", frontier("99"))).toBe("unread")
    expect(rowReadState("99", "msg_1", frontier("100"))).toBe("read")
  })

  it("is read when the id is in the overlay even though its sequence is past the frontier", () => {
    expect(rowReadState("6", "msg_ov", frontier("5", new Set(["msg_ov"])))).toBe("read")
  })

  it("is read (overlay) even with no resolvable frontier — the overlay is authoritative", () => {
    expect(rowReadState(undefined, "msg_ov", frontier(null, new Set(["msg_ov"])))).toBe("read")
  })

  it("still gates by sequence for a row whose id is NOT in the overlay", () => {
    const ov = new Set(["msg_other"])
    expect(rowReadState("6", "msg_1", frontier("5", ov))).toBe("unread")
    expect(rowReadState("5", "msg_1", frontier("5", ov))).toBe("read")
  })
})
