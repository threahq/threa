import { describe, expect, test } from "bun:test"
import {
  API_VERSIONS,
  CURRENT_API_VERSION,
  assertChangesAscending,
  changesAfter,
  deriveVersionSpec,
  parseApiVersion,
  type OpenApiSpec,
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

describe("deriveVersionSpec", () => {
  const canonical = (): OpenApiSpec => ({ openapi: "3.0.3", info: { title: "T", version: "9999-99-99" }, paths: {} })

  test("stamps info.version and leaves everything else untouched with an empty registry", () => {
    const spec = deriveVersionSpec(canonical(), CURRENT_API_VERSION, [])
    expect(spec).toEqual({ openapi: "3.0.3", info: { title: "T", version: CURRENT_API_VERSION }, paths: {} })
  })

  test("does not mutate the canonical spec it is handed", () => {
    const input = canonical()
    deriveVersionSpec(input, CURRENT_API_VERSION, [])
    expect(input.info).toEqual({ title: "T", version: "9999-99-99" })
  })

  const specChange = (version: string, marker: string): VersionChange => ({
    version: version as VersionChange["version"],
    description: `change ${version}`,
    operations: new Set(),
    downgradeSpec: (spec) => ({ ...spec, [`downgraded_${marker}`]: true }),
  })

  test("applies downgradeSpec newest→oldest for changes strictly newer than the target version", () => {
    const older = specChange("2026-08-01", "older")
    const newer = specChange("2026-11-01", "newer")

    // Target older than both → both applied.
    const both = deriveVersionSpec(canonical(), "2026-07-12" as never, [older, newer])
    expect(both).toMatchObject({ downgraded_older: true, downgraded_newer: true, info: { version: "2026-07-12" } })

    // Target at the older change's version → only the newer change applies.
    const onlyNewer = deriveVersionSpec(canonical(), "2026-08-01" as never, [older, newer])
    expect(onlyNewer.downgraded_newer).toBe(true)
    expect(onlyNewer.downgraded_older).toBeUndefined()

    // Target at the newest version → no changes apply.
    const none = deriveVersionSpec(canonical(), "2026-11-01" as never, [older, newer])
    expect(none.downgraded_older).toBeUndefined()
    expect(none.downgraded_newer).toBeUndefined()
  })

  test("applies newest→oldest so an older change sees the newer change's output", () => {
    const order: string[] = []
    const older: VersionChange = {
      version: "2026-08-01" as never,
      description: "older",
      operations: new Set(),
      downgradeSpec: (spec) => {
        order.push("older")
        return spec
      },
    }
    const newer: VersionChange = {
      version: "2026-11-01" as never,
      description: "newer",
      operations: new Set(),
      downgradeSpec: (spec) => {
        order.push("newer")
        return spec
      },
    }
    deriveVersionSpec(canonical(), "2026-07-12" as never, [older, newer])
    expect(order).toEqual(["newer", "older"])
  })
})
