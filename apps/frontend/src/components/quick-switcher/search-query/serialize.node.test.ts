import { describe, it, expect } from "vitest"
import { serialize } from "./serialize"
import { parse } from "./parse"
import type { QueryNode } from "./types"

describe("serialize", () => {
  it("should serialize a single text node", () => {
    const nodes: QueryNode[] = [{ type: "text", text: "restaurants" }]
    expect(serialize(nodes)).toBe("restaurants")
  })

  it("should serialize a filter node to filterType:value", () => {
    const nodes: QueryNode[] = [{ type: "filter", filterType: "from", value: "@martin" }]
    expect(serialize(nodes)).toBe("from:@martin")
  })

  it("should serialize multiple filter nodes", () => {
    const nodes: QueryNode[] = [
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "filter", filterType: "in", value: "#general" },
    ]
    expect(serialize(nodes)).toBe("from:@martin in:#general")
  })

  it("should serialize plain text as-is", () => {
    const nodes: QueryNode[] = [{ type: "text", text: "hello world" }]
    expect(serialize(nodes)).toBe("hello world")
  })

  it("should join multiple nodes with spaces", () => {
    const nodes: QueryNode[] = [
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "text", text: "restaurants" },
      { type: "filter", filterType: "status", value: "active" },
    ]
    expect(serialize(nodes)).toBe("from:@martin restaurants status:active")
  })

  it("should preserve quoted strings as literal text", () => {
    const nodes: QueryNode[] = [{ type: "text", text: "from:@martin", isQuoted: true }]
    expect(serialize(nodes)).toBe('"from:@martin"')
  })

  it("should handle empty node array", () => {
    const nodes: QueryNode[] = []
    expect(serialize(nodes)).toBe("")
  })

  it("should serialize all filter types", () => {
    const nodes: QueryNode[] = [
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "filter", filterType: "with", value: "@kate" },
      { type: "filter", filterType: "in", value: "#general" },
      { type: "filter", filterType: "type", value: "channel" },
      { type: "filter", filterType: "status", value: "active" },
      { type: "filter", filterType: "after", value: "2025-01-01" },
      { type: "filter", filterType: "before", value: "2025-12-31" },
    ]
    expect(serialize(nodes)).toBe(
      "from:@martin with:@kate in:#general type:channel status:active after:2025-01-01 before:2025-12-31"
    )
  })
})

describe("parse", () => {
  it("should parse from:@slug into filter node", () => {
    const result = parse("from:@martin")
    expect(result).toEqual([{ type: "filter", filterType: "from", value: "@martin" }])
  })

  it("should parse with:@slug into filter node", () => {
    const result = parse("with:@kate")
    expect(result).toEqual([{ type: "filter", filterType: "with", value: "@kate" }])
  })

  it("should parse in:#channel into filter node", () => {
    const result = parse("in:#general")
    expect(result).toEqual([{ type: "filter", filterType: "in", value: "#general" }])
  })

  it("should parse in:@user into filter node (DM)", () => {
    const result = parse("in:@martin")
    expect(result).toEqual([{ type: "filter", filterType: "in", value: "@martin" }])
  })

  it("should parse type:channel into filter node", () => {
    const result = parse("type:channel")
    expect(result).toEqual([{ type: "filter", filterType: "type", value: "channel" }])
  })

  it("should parse status:active into filter node", () => {
    const result = parse("status:active")
    expect(result).toEqual([{ type: "filter", filterType: "status", value: "active" }])
  })

  it("should parse is:scratchpad into type filter node", () => {
    const result = parse("is:scratchpad")
    expect(result).toEqual([{ type: "filter", filterType: "type", value: "scratchpad" }])
  })

  it("should parse after:date into filter node", () => {
    const result = parse("after:2025-01-15")
    expect(result).toEqual([{ type: "filter", filterType: "after", value: "2025-01-15" }])
  })

  it("should parse before:date into filter node", () => {
    const result = parse("before:2025-12-31")
    expect(result).toEqual([{ type: "filter", filterType: "before", value: "2025-12-31" }])
  })

  it("should parse @slug as text node (NOT filter)", () => {
    const result = parse("@martin")
    expect(result).toEqual([{ type: "text", text: "@martin" }])
  })

  it("should parse #channel as text node (NOT filter)", () => {
    const result = parse("#general")
    expect(result).toEqual([{ type: "text", text: "#general" }])
  })

  it("should parse quoted string as literal text", () => {
    const result = parse('"from:@martin"')
    expect(result).toEqual([{ type: "text", text: "from:@martin", isQuoted: true }])
  })

  it("should handle mixed filters and text", () => {
    const result = parse("from:@martin restaurants in:#general")
    expect(result).toEqual([
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "text", text: "restaurants" },
      { type: "filter", filterType: "in", value: "#general" },
    ])
  })

  it("should normalize ? prefix (remove it)", () => {
    const result = parse("? from:@martin")
    expect(result).toEqual([{ type: "filter", filterType: "from", value: "@martin" }])
  })

  it("should handle multiple consecutive spaces", () => {
    const result = parse("from:@martin   restaurants")
    expect(result).toEqual([
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "text", text: "restaurants" },
    ])
  })

  it("should handle empty string", () => {
    const result = parse("")
    expect(result).toEqual([])
  })

  it("should handle only whitespace", () => {
    const result = parse("   ")
    expect(result).toEqual([])
  })

  it("should handle complex query with all filter types", () => {
    const result = parse("from:@martin with:@kate in:#general type:channel status:active after:2025-01-01 restaurants")
    expect(result).toEqual([
      { type: "filter", filterType: "from", value: "@martin" },
      { type: "filter", filterType: "with", value: "@kate" },
      { type: "filter", filterType: "in", value: "#general" },
      { type: "filter", filterType: "type", value: "channel" },
      { type: "filter", filterType: "status", value: "active" },
      { type: "filter", filterType: "after", value: "2025-01-01" },
      { type: "text", text: "restaurants" },
    ])
  })
})

describe("roundtrip (parse -> serialize -> parse)", () => {
  const testCases = [
    "from:@martin",
    "from:@martin in:#general",
    "from:@martin restaurants status:active",
    "restaurants",
    "@martin",
    "#general",
    "from:@martin with:@kate in:#general type:channel status:active after:2025-01-01 before:2025-12-31 restaurants",
  ]

  for (const input of testCases) {
    it(`should roundtrip: "${input}"`, () => {
      const parsed = parse(input)
      const serialized = serialize(parsed)
      const reparsed = parse(serialized)
      expect(reparsed).toEqual(parsed)
    })
  }

  it("should normalize ? prefix in roundtrip", () => {
    const input = "? from:@martin"
    const parsed = parse(input)
    const serialized = serialize(parsed)
    expect(serialized).toBe("from:@martin")
    const reparsed = parse(serialized)
    expect(reparsed).toEqual(parsed)
  })
})
