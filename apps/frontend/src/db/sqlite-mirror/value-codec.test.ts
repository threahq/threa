import { describe, expect, it } from "vitest"
import { decodeValue, encodeValue, UnmirrorableValueError } from "./value-codec"

function roundTrip(value: unknown): unknown {
  return decodeValue(encodeValue(value))
}

describe("value codec", () => {
  it("round-trips plain data, binaries, dates, undefined and non-finite numbers", () => {
    const value = {
      id: "msg_1",
      n: 3,
      nested: { list: [1, "two", null, undefined, { deep: true }], when: new Date(1700000000000) },
      bytes: new Uint8Array([0, 1, 255]),
      buffer: new Uint8Array([4, 5]).buffer,
      missing: undefined,
      specials: [NaN, Infinity, -Infinity, -0],
    }
    const result = roundTrip(value) as typeof value
    expect(result).toEqual(value)
    expect(result.bytes).toBeInstanceOf(Uint8Array)
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
    expect(result.nested.when).toBeInstanceOf(Date)
    expect(Object.is(result.specials[3], -0)).toBe(true)
    expect("missing" in result).toBe(true)
  })

  it("round-trips primitives at the top level", () => {
    expect([1, "s", null, true, undefined, [], {}].map(roundTrip)).toEqual([1, "s", null, true, undefined, [], {}])
  })

  it("round-trips objects that look like codec tags", () => {
    const lookalikes = [
      { $t: "date", v: 5 },
      { $t: "undefined" },
      { $t: "object", v: { $t: "bytes", v: "AA==" } },
      { list: [{ $t: "number", v: "NaN" }] },
    ]
    expect(lookalikes.map(roundTrip)).toEqual(lookalikes)
  })

  it("throws UnmirrorableValueError for unsupported types", () => {
    class Custom {}
    const unsupported = [
      new Blob(["x"]),
      new Map(),
      new Set(),
      new Custom(),
      1n,
      () => 1,
      new Date(NaN),
      new Uint16Array(1),
    ]
    for (const value of unsupported) {
      expect(() => encodeValue({ nested: [value] })).toThrow(UnmirrorableValueError)
    }
  })
})
