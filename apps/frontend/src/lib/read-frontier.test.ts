import { describe, it, expect } from "vitest"
import { resolveFrontierEventId, resolveFrontierSequence } from "./read-frontier"

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

describe("resolveFrontierSequence", () => {
  it("stays undefined (hydrating) while the row is absent", () => {
    expect(resolveFrontierSequence(undefined)).toBeUndefined()
  })

  it("a present never-read row resolves to null", () => {
    expect(resolveFrontierSequence({ lastReadEventId: null, lastReadSequence: null })).toBeNull()
  })

  it("a present row with a sequence resolves to it", () => {
    expect(resolveFrontierSequence({ lastReadEventId: "evt_rs", lastReadSequence: "7" })).toBe(7n)
  })

  it("a watermark with no sequence is unresolvable, never guessed as never-read", () => {
    expect(resolveFrontierSequence({ lastReadEventId: "evt_rs", lastReadSequence: null })).toBeUndefined()
  })
})
