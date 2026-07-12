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
    try {
      parseApiVersion("2020-01-01")
      throw new Error("expected parseApiVersion to throw")
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string }
      expect(e.status).toBe(400)
      expect(e.code).toBe("INVALID_API_VERSION")
      expect(e.message).toContain(API_VERSIONS.join(", "))
    }
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
})
