import { describe, it, expect } from "vitest"
import { rowReadState } from "./read-frontier-context"

describe("rowReadState", () => {
  it("is ungated when there is no frontier (unresolved / out-of-window)", () => {
    expect(rowReadState("5", null)).toBe("ungated")
  })

  it("is ungated when the row has no sequence yet (optimistic send)", () => {
    expect(rowReadState(undefined, "5")).toBe("ungated")
    expect(rowReadState(null, "5")).toBe("ungated")
  })

  it("is unread when the row sits strictly past the frontier", () => {
    expect(rowReadState("6", "5")).toBe("unread")
  })

  it("is read at or before the frontier (the frontier row is the last read)", () => {
    expect(rowReadState("5", "5")).toBe("read")
    expect(rowReadState("4", "5")).toBe("read")
  })

  it("treats a '0' frontier (nothing read) as everything unread", () => {
    expect(rowReadState("1", "0")).toBe("unread")
  })

  it("compares as integers, not lexically (large sequences)", () => {
    expect(rowReadState("100", "99")).toBe("unread")
    expect(rowReadState("99", "100")).toBe("read")
  })
})
