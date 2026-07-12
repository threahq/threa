import { describe, expect, test } from "bun:test"
import {
  API_VERSIONS,
  CURRENT_API_VERSION,
  assertChangesAscending,
  changesAfter,
  parseApiVersion,
  type VersionChange,
} from "./index"

describe("parseApiVersion", () => {
  test("returns a known version unchanged", () => {
    expect(parseApiVersion(CURRENT_API_VERSION)).toBe(CURRENT_API_VERSION)
  })

  test("throws 400 INVALID_API_VERSION on an unknown version, listing known versions", () => {
    let thrown: unknown
    try {
      parseApiVersion("2020-01-01")
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({
      status: 400,
      code: "INVALID_API_VERSION",
      message: expect.stringContaining(API_VERSIONS.join(", ")),
    })
  })

  test("throws on a malformed / non-date value", () => {
    for (const bad of ["latest", "", "2026-7-12", "not-a-date"]) {
      expect(() => parseApiVersion(bad)).toThrow()
    }
  })
})

const change = (version: string, ops: string[] = []): VersionChange => ({
  version: version as VersionChange["version"],
  description: `change ${version}`,
  operations: new Set(ops as never[]),
})

describe("assertChangesAscending", () => {
  test("accepts empty and strictly-ascending lists", () => {
    expect(() => assertChangesAscending([])).not.toThrow()
    expect(() => assertChangesAscending([change("2026-07-12"), change("2026-11-01")])).not.toThrow()
  })

  test("rejects equal or descending versions", () => {
    expect(() => assertChangesAscending([change("2026-11-01"), change("2026-11-01")])).toThrow()
    expect(() => assertChangesAscending([change("2026-11-01"), change("2026-07-12")])).toThrow()
  })
})

describe("changesAfter", () => {
  test("returns no changes in the Phase-1 steady state (empty registry)", () => {
    expect(changesAfter(CURRENT_API_VERSION)).toEqual([])
  })

  test("returns only strictly-newer changes, in registry order", () => {
    const a = change("2026-08-01")
    const b = change("2026-11-01")
    const c = change("2027-01-01")
    expect(changesAfter("2026-07-12" as never, [a, b, c])).toEqual([a, b, c])
    // Equal is excluded — a caller pinned AT a change's version already has it.
    expect(changesAfter("2026-11-01" as never, [a, b, c])).toEqual([c])
    expect(changesAfter("2027-01-01" as never, [a, b, c])).toEqual([])
  })
})
