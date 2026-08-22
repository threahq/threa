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
import type { OperationId } from "../routes"

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

  test("registry is ascending and scopes every operation whose thread-anchor behavior changed", () => {
    expect(() => assertChangesAscending(VERSION_CHANGES)).not.toThrow()
    // The anchor change shipped at 2026-07-22; the slots change (2026-07-24) is
    // now the current version.
    expect(anchorChange.version).toBe("2026-07-22")
    expect([...anchorChange.operations].sort()).toEqual([
      "completeDelegation",
      "getStream",
      "listStreams",
      "updateStream",
    ])
  })

  test("an older pin is behind on it; a caller at the current version is not", () => {
    expect(changesAfter("2026-07-12" as never)).toContain(anchorChange)
    expect(changesAfter(CURRENT_API_VERSION)).not.toContain(anchorChange)
  })

  test("completion payloads need no structural downgrade because behavior branches before side effects", () => {
    const payload = { data: { resultMessageId: "msg_anchor", resultThreadId: "stream_thread" } }
    expect(anchorChange.downgradeResponse!(payload, { operationId: "completeDelegation" })).toBe(payload)
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

  test("downgradeSpec restores the legacy delegation completion description", () => {
    const spec: OpenApiSpec = {
      paths: {
        "/delegations/{id}/complete": {
          post: {
            operationId: "completeDelegation",
            description: "Current card-thread behavior",
          },
        },
      },
    }
    const out = anchorChange.downgradeSpec!(spec) as any
    expect(out.paths["/delegations/{id}/complete"].post.description).toContain("compact resultMessageId anchor")
    expect((spec as any).paths["/delegations/{id}/complete"].post.description).toBe("Current card-thread behavior")
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

describe("VERSION_CHANGES: the 2026-07-24 slots change", () => {
  const slotsChange = VERSION_CHANGES.find((c) => c.version === "2026-07-24")!
  const SEVEN: OperationId[] = [
    "completeBotInvocation",
    "findMessagesByMetadata",
    "listConversationMessages",
    "listMessages",
    "searchMessages",
    "sendMessage",
    "updateMessage",
  ]

  test("is ascending and scopes exactly the seven message-rendering operations", () => {
    expect(() => assertChangesAscending(VERSION_CHANGES)).not.toThrow()
    expect([...slotsChange.operations].sort()).toEqual(SEVEN)
  })

  test("downgradeResponse strips only the top-level slots map for a scoped operation", () => {
    const payload = { data: [{ id: "msg_1" }], hasMore: false, slots: { "shared:msg_src": { state: "ok" } } }
    const out = slotsChange.downgradeResponse!(payload, { operationId: "listMessages" })
    expect(out).toEqual({ data: [{ id: "msg_1" }], hasMore: false })
  })

  test("downgradeResponse passes payloads through untouched for operations outside the seven", () => {
    const payload = { data: { id: "stream_1" }, slots: { "shared:x": {} } }
    expect(slotsChange.downgradeResponse!(payload, { operationId: "getStream" })).toBe(payload)
  })

  test("downgradeResponse tolerates non-object and slot-less payloads", () => {
    expect(slotsChange.downgradeResponse!(null, { operationId: "listMessages" })).toBeNull()
    const noSlots = { data: [] }
    expect(slotsChange.downgradeResponse!(noSlots, { operationId: "searchMessages" })).toEqual({ data: [] })
  })

  test("downgradeSpec removes slots from the seven operations' responses but leaves others intact", () => {
    const responseNode = {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { data: { type: "array" }, slots: { type: "object" } },
              required: ["data", "slots"],
            },
          },
        },
      },
    }
    const spec: OpenApiSpec = {
      paths: {
        "/messages": { get: { operationId: "listMessages", responses: structuredClone(responseNode) } },
        "/streams": { get: { operationId: "listStreams", responses: structuredClone(responseNode) } },
      },
    }
    const out = slotsChange.downgradeSpec!(spec) as any
    const listProps = out.paths["/messages"].get.responses["200"].content["application/json"].schema
    expect(listProps.properties.slots).toBeUndefined()
    expect(listProps.required).toEqual(["data"])
    // A non-scoped operation keeps its slots node.
    const streamProps = out.paths["/streams"].get.responses["200"].content["application/json"].schema
    expect(streamProps.properties.slots).toBeDefined()
  })

  test("composes newest→oldest: a 2026-07-12 pin gets both the slots strip and the anchor downgrade", () => {
    const spec: OpenApiSpec = {
      paths: {
        "/messages": {
          get: {
            operationId: "listMessages",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { slots: { type: "object" } }, required: ["slots"] },
                  },
                },
              },
            },
          },
        },
        "/streams/{id}": {
          get: {
            operationId: "getStream",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          properties: { id: { type: "string" }, anchorId: { type: "string" } },
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
    const out = deriveVersionSpec(spec, "2026-07-12" as never) as any
    // Slots stripped from listMessages (2026-07-24 change).
    expect(
      out.paths["/messages"].get.responses["200"].content["application/json"].schema.properties.slots
    ).toBeUndefined()
    // anchorId removed from getStream (2026-07-22 change).
    expect(
      out.paths["/streams/{id}"].get.responses["200"].content["application/json"].schema.properties.data.properties
        .anchorId
    ).toBeUndefined()
    expect(out.info.version).toBe("2026-07-12")
  })
})

describe("VERSION_CHANGES: the 2026-08-21 pinned-reference change", () => {
  const pinChange = VERSION_CHANGES.find((c) => c.version === "2026-08-21")!
  const ok = (messageId: string, version: number, range: { from: number; to: number } | null) => ({
    type: "sharedMessage",
    state: "ok",
    messageId,
    content: range ? "span" : `whole v${version}`,
    version,
    currentRevision: 3,
    range,
  })

  test("is the current version and scopes the same seven operations as the slots change", () => {
    expect(CURRENT_API_VERSION).toBe("2026-08-21")
    expect([...pinChange.operations].sort()).toEqual(
      [...VERSION_CHANGES.find((c) => c.version === "2026-07-24")!.operations].sort()
    )
  })

  test("downgradeResponse collapses reference keys onto one legacy key per source without the pin fields", () => {
    const payload = {
      data: [],
      slots: {
        "shared:msg_a@2:1-4": ok("msg_a", 2, { from: 1, to: 4 }),
        "shared:msg_a@1": ok("msg_a", 1, null),
        "shared:msg_a@3": ok("msg_a", 3, null),
        "shared:msg_b": {
          type: "sharedMessage",
          state: "deleted",
          messageId: "msg_b",
          deletedAt: "2026-08-21T00:00:00.000Z",
        },
      },
    }
    expect(pinChange.downgradeResponse!(payload, { operationId: "listMessages" })).toEqual({
      data: [],
      slots: {
        "shared:msg_a": { type: "sharedMessage", state: "ok", messageId: "msg_a", content: "whole v3" },
        "shared:msg_b": {
          type: "sharedMessage",
          state: "deleted",
          messageId: "msg_b",
          deletedAt: "2026-08-21T00:00:00.000Z",
        },
      },
    })
  })

  test("downgradeResponse omits a span rather than passing a fragment off as the message", () => {
    const payload = {
      data: [],
      slots: { "shared:msg_a@2:1-4": ok("msg_a", 2, { from: 1, to: 4 }) },
    }
    expect(pinChange.downgradeResponse!(payload, { operationId: "listMessages" })).toEqual({ data: [], slots: {} })
  })

  test("downgradeResponse leaves other operations and slot-less payloads alone", () => {
    const stream = { data: { id: "stream_1" }, slots: { "shared:x@1": {} } }
    expect(pinChange.downgradeResponse!(stream, { operationId: "getStream" })).toBe(stream)
    const noSlots = { data: [] }
    expect(pinChange.downgradeResponse!(noSlots, { operationId: "listMessages" })).toBe(noSlots)
  })

  test("downgradeSpec drops the pin fields from the ok slot schema and restores the legacy map description", () => {
    const spec = {
      components: {
        schemas: {
          Slot: {
            type: "object",
            properties: {
              content: { type: "string", description: "The referenced revision of the source as markdown." },
              attachments: { type: "array", description: "Source attachments; empty when the slot renders a span." },
              version: {},
              currentRevision: {},
              range: {},
            },
            required: ["content", "version", "currentRevision", "range"],
          },
          SlotMap: {
            type: "object",
            description:
              "Hydration for shared-message pointers in the returned messages, keyed by the pointer's reference: …",
          },
        },
      },
    }
    expect(pinChange.downgradeSpec!(spec)).toEqual({
      components: {
        schemas: {
          Slot: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Source message content as markdown. The canonical rich-text JSON stays internal.",
              },
              attachments: { type: "array" },
            },
            required: ["content"],
          },
          SlotMap: {
            type: "object",
            description:
              "Hydration for cross-stream shared-message pointers in the returned messages, keyed by `shared:<messageId>`. Always present; empty when no message references a shared source.",
          },
        },
      },
    })
  })
})
