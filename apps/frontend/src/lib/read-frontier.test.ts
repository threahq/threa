import { describe, it, expect } from "vitest"
import { resolveFrontierEventId } from "./read-frontier"

describe("resolveFrontierEventId", () => {
  it("a present row with a watermark resolves to it", () => {
    expect(resolveFrontierEventId({ lastReadEventId: "evt_rs" })).toBe("evt_rs")
  })

  it("a present row with a null watermark resolves to null (explicit unread-to-zero)", () => {
    expect(resolveFrontierEventId({ lastReadEventId: null })).toBeNull()
  })

  it("stays undefined (hydrating) while the row is absent", () => {
    expect(resolveFrontierEventId(undefined)).toBeUndefined()
  })
})
