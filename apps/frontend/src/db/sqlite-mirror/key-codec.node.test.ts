import { describe, expect, it } from "vitest"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { compareBytes, encodeKey, encodeRange, isKeyInRange } from "./key-codec"

function createRng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const NUMBERS = [0, -0, 1, -1, 0.5, -0.5, 1e300, -1e300, 5e-324, -5e-324, Infinity, -Infinity, 42, 1024, -1024]
const STRING_UNITS = ["", "a", "b", "\u0000", "\u0001", "ÿ", "Ā", "\ud800", "\udc00", "￿", "z"]

function randomKey(rng: () => number, depth: number): IDBValidKey {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]
  const kind = Math.floor(rng() * (depth > 2 ? 4 : 5))
  if (kind === 0) return rng() < 0.5 ? pick(NUMBERS) : (rng() - 0.5) * 2 ** Math.floor(rng() * 60)
  if (kind === 1) return new Date(pick([-1e12, 0, 1, 1.7e12, 8.64e15 - 3]) + Math.floor(rng() * 3))
  if (kind === 2) {
    let s = ""
    for (let i = Math.floor(rng() * 4); i > 0; i--) s += pick(STRING_UNITS)
    return s
  }
  if (kind === 3) {
    const bytes = new Uint8Array(1 + Math.floor(rng() * 3)).map(() => pick([0, 1, 2, 0xfe, 0xff]))
    return rng() < 0.5 ? bytes : bytes.buffer
  }
  return Array.from({ length: Math.floor(rng() * 4) }, () => randomKey(rng, depth + 1))
}

describe("encodeKey", () => {
  it("orders encoded bytes exactly like indexedDB.cmp across random mixed keys", () => {
    const rng = createRng(1234)
    const keys = Array.from({ length: 800 }, () => randomKey(rng, 0))
    const mismatches: unknown[] = []
    let pairs = 0
    for (let i = 0; i < 4000; i++) {
      const a = keys[Math.floor(rng() * keys.length)]
      const b = keys[Math.floor(rng() * keys.length)]
      pairs++
      const expected = indexedDB.cmp(a, b)
      const actual = compareBytes(encodeKey(a), encodeKey(b))
      if (expected !== actual) mismatches.push({ a, b, expected, actual })
    }
    expect({ pairs, mismatches }).toEqual({ pairs: 4000, mismatches: [] })
  })

  it("sorts the edge cases in IndexedDB order", () => {
    const ordered: IDBValidKey[] = [
      -Infinity,
      -1,
      0,
      1,
      Infinity,
      new Date(0),
      "",
      "a",
      "a\u0000",
      "a\u0001",
      "ab",
      "abc",
      "b",
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0, 0]),
      new Uint8Array([1]),
      [],
      [-1],
      [0, "a"],
      ["a"],
      [[]],
    ]
    const sorted = [...ordered].reverse().sort((a, b) => compareBytes(encodeKey(a), encodeKey(b)))
    expect(sorted).toEqual(ordered)
  })

  it("encodes -0 and 0 identically and rejects invalid keys", () => {
    expect(encodeKey(-0)).toEqual(encodeKey(0))
    expect(() => encodeKey(NaN)).toThrow()
    expect(() => encodeKey(new Date(NaN))).toThrow()
    expect(() => encodeKey({} as unknown as IDBValidKey)).toThrow()
  })

  it("encodes typed-array views by their visible bytes", () => {
    const view = new Uint8Array([9, 1, 2, 9]).subarray(1, 3)
    expect(encodeKey(view)).toEqual(encodeKey(new Uint8Array([1, 2])))
  })
})

describe("encodeRange", () => {
  const range = (lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false) =>
    encodeRange({ type: 2, lower, upper, lowerOpen, upperOpen })

  it("matches keys the way IDBKeyRange does", () => {
    const rng = createRng(99)
    const keys = Array.from({ length: 200 }, () => randomKey(rng, 0))
    const failures: unknown[] = []
    for (let i = 0; i < 300; i++) {
      const lower = randomKey(rng, 0)
      const upper = randomKey(rng, 0)
      if (indexedDB.cmp(lower, upper) > 0) continue
      const lowerOpen = rng() < 0.5
      const upperOpen = rng() < 0.5
      if (indexedDB.cmp(lower, upper) === 0 && (lowerOpen || upperOpen)) continue
      const idbRange = IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen)
      const encoded = range(lower, upper, lowerOpen, upperOpen)
      for (const key of keys) {
        if (idbRange.includes(key) !== isKeyInRange(encodeKey(key), encoded)) failures.push({ lower, upper, key })
      }
    }
    expect(failures).toEqual([])
  })

  it("handles unbounded, equal, any and never ranges", () => {
    const inRange = (r: ReturnType<typeof encodeRange>) => [1, 2, 3].filter((k) => isKeyInRange(encodeKey(k), r))
    expect({
      lowerOnly: inRange(range(2, undefined, true)),
      upperOnly: inRange(range(undefined, 2)),
      equal: inRange(encodeRange({ type: 1, lower: 2, upper: 2 })),
      any: inRange(encodeRange({ type: 3, lower: undefined, upper: undefined })),
      never: inRange(encodeRange({ type: 4, lower: undefined, upper: undefined })),
    }).toEqual({ lowerOnly: [3], upperOnly: [1, 2], equal: [2], any: [1, 2, 3], never: [] })
  })
})
