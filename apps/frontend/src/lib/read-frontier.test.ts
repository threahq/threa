import { describe, it, expect } from "vitest"
import { resolveFrontierEventId } from "./read-frontier"

describe("resolveFrontierEventId", () => {
  it("a present read-state row wins — including a null watermark (explicit unread-to-zero)", () => {
    // The standalone row exists with a NULL watermark; the stale non-null
    // mirrors must NOT fall through (row presence, not field nullability).
    expect(
      resolveFrontierEventId(
        { lastReadEventId: null },
        { lastReadEventId: "evt_stale" },
        { lastReadEventId: "evt_stale" }
      )
    ).toBeNull()
  })

  it("a present read-state row with a watermark beats the mirrors", () => {
    expect(
      resolveFrontierEventId(
        { lastReadEventId: "evt_rs" },
        { lastReadEventId: "evt_idb" },
        { lastReadEventId: "evt_m" }
      )
    ).toBe("evt_rs")
  })

  it("falls back to the idb stream mirror when no read-state row exists", () => {
    expect(resolveFrontierEventId(undefined, { lastReadEventId: "evt_idb" }, { lastReadEventId: "evt_m" })).toBe(
      "evt_idb"
    )
  })

  it("falls back to the membership mirror when neither row nor idb field exists", () => {
    expect(resolveFrontierEventId(undefined, { lastReadEventId: undefined }, { lastReadEventId: "evt_m" })).toBe(
      "evt_m"
    )
    expect(resolveFrontierEventId(undefined, undefined, { lastReadEventId: null })).toBeNull()
  })

  it("stays undefined (unresolved) while every source is still hydrating", () => {
    expect(resolveFrontierEventId(undefined, undefined, undefined)).toBeUndefined()
    expect(resolveFrontierEventId(undefined, { lastReadEventId: undefined }, undefined)).toBeUndefined()
  })
})
