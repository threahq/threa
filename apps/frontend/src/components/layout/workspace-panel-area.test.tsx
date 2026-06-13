import { describe, expect, it } from "vitest"
import { reconcileSlots } from "./workspace-panel-area"

/** Deterministic key generator so assertions can name the keys. */
function keygen() {
  let n = 0
  return () => `slot-${n++}`
}

describe("reconcileSlots", () => {
  it("returns the same array when the live ids are unchanged", () => {
    const prev = [{ id: "a", key: "k1" }]
    expect(reconcileSlots(prev, ["a"], keygen())).toBe(prev)
  })

  it("appends a new slot with a fresh key", () => {
    const prev = [{ id: "a", key: "k1" }]
    expect(reconcileSlots(prev, ["a", "b"], keygen())).toEqual([
      { id: "a", key: "k1" },
      { id: "b", key: "slot-0" },
    ])
  })

  it("keeps a removed id mounted as a closing slot at its old position", () => {
    const prev = [
      { id: "a", key: "k1" },
      { id: "b", key: "k2" },
    ]
    expect(reconcileSlots(prev, ["a"], keygen())).toEqual([
      { id: "a", key: "k1" },
      { id: "b", key: "k2", closing: true },
    ])
  })

  it("transfers the slot key on a single same-position id swap (no close/reopen)", () => {
    const prev = [
      { id: "a", key: "k1" },
      { id: "draft:s:m", key: "k2" },
    ]
    // Draft thread promotes to its real thread id in place.
    const next = reconcileSlots(prev, ["a", "stream_real"], keygen())
    expect(next).toEqual([
      { id: "a", key: "k1" },
      { id: "stream_real", key: "k2" },
    ])
    expect(next.some((it) => it.closing)).toBe(false)
  })

  it("revives a closing slot (and its key) when its id reopens before unmount", () => {
    const prev = [
      { id: "a", key: "k1" },
      { id: "b", key: "k2", closing: true },
    ]
    expect(reconcileSlots(prev, ["a", "b"], keygen())).toEqual([
      { id: "a", key: "k1" },
      { id: "b", key: "k2" },
    ])
  })

  it("preserves an unrelated closing slot across a separate open", () => {
    const prev = [
      { id: "a", key: "k1" },
      { id: "b", key: "k2", closing: true },
    ]
    // `b` is still animating closed while `c` opens.
    expect(reconcileSlots(prev, ["a", "c"], keygen())).toEqual([
      { id: "a", key: "k1" },
      { id: "b", key: "k2", closing: true },
      { id: "c", key: "slot-0" },
    ])
  })

  it("treats a remove + add at different positions as a real close, not a swap", () => {
    const prev = [
      { id: "a", key: "k1" },
      { id: "b", key: "k2" },
    ]
    // b leaves and c arrives, but the positions don't line up (c is first), so
    // this is NOT an in-place swap: b animates closed, c gets a fresh key.
    expect(reconcileSlots(prev, ["c", "a"], keygen())).toEqual([
      { id: "c", key: "slot-0" },
      { id: "b", key: "k2", closing: true },
      { id: "a", key: "k1" },
    ])
  })
})
