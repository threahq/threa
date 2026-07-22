import { describe, expect, test } from "bun:test"
import {
  API_VERSIONS,
  CURRENT_API_VERSION,
  VERSION_CHANGES,
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

describe("VERSION_CHANGES: the anchorId stream change (first real entry)", () => {
  const anchorChange = VERSION_CHANGES.find((c) => c.operations.has("listStreams"))!
  const ctx = { operationId: "getStream" } as const

  test("registry is ascending and the entry is dated at the current version, scoped to the stream-embedding operations", () => {
    expect(() => assertChangesAscending(VERSION_CHANGES)).not.toThrow()
    expect(anchorChange.version).toBe(CURRENT_API_VERSION)
    expect([...anchorChange.operations].sort()).toEqual(["getStream", "listStreams", "updateStream"])
  })

  test("an older pin is behind on it; a caller at the current version is not", () => {
    expect(changesAfter("2026-07-12" as never)).toContain(anchorChange)
    expect(changesAfter(CURRENT_API_VERSION)).not.toContain(anchorChange)
  })

  test("downgradeResponse lowers a message-anchored stream to parentMessageId (single-object envelope)", () => {
    const out = anchorChange.downgradeResponse!({ data: { id: "stream_t", type: "thread", anchorId: "msg_abc" } }, ctx)
    expect(out).toEqual({ data: { id: "stream_t", type: "thread", parentMessageId: "msg_abc" } })
  })

  test("downgradeResponse drops an event anchor entirely — old clients never knew that shape", () => {
    const out = anchorChange.downgradeResponse!(
      { data: { id: "stream_t", type: "thread", anchorId: "event_xyz" } },
      ctx
    )
    expect(out).toEqual({ data: { id: "stream_t", type: "thread" } })
  })

  test("downgradeResponse transforms every item of a paginated envelope, preserving page metadata", () => {
    const out = anchorChange.downgradeResponse!(
      {
        data: [{ id: "s1", anchorId: "msg_1" }, { id: "s2", anchorId: "event_2" }, { id: "s3" }],
        hasMore: true,
        cursor: "cur_1",
      },
      ctx
    )
    expect(out).toEqual({
      data: [{ id: "s1", parentMessageId: "msg_1" }, { id: "s2" }, { id: "s3" }],
      hasMore: true,
      cursor: "cur_1",
    })
  })

  test("downgradeSpec restores an optional parentMessageId and removes anchorId from a stream schema node", () => {
    const spec: OpenApiSpec = {
      paths: {
        "/streams/{id}": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            type: { type: "string" },
                            displayName: { type: "string" },
                            visibility: { type: "string" },
                            anchorId: { type: "string", description: "…" },
                          },
                          required: ["id", "type", "displayName", "visibility"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const streamNode = (spec2: OpenApiSpec) =>
      (spec2 as any).paths["/streams/{id}"].get.responses["200"].content["application/json"].schema.properties.data
    const out = anchorChange.downgradeSpec!(spec)
    const props = streamNode(out).properties
    expect(props.anchorId).toBeUndefined()
    expect(props.parentMessageId).toEqual({ type: "string" })
    // required is untouched (both fields were always optional)
    expect(streamNode(out).required).toEqual(["id", "type", "displayName", "visibility"])
    // pure — the input spec is not mutated
    expect(streamNode(spec).properties.anchorId).toBeDefined()
    expect(streamNode(spec).properties.parentMessageId).toBeUndefined()
  })
})
