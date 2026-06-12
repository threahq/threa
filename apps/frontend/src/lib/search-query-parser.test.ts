import { describe, it, expect } from "vitest"
import {
  parseSearchQuery,
  serializeSearchQuery,
  removeFilterFromQuery,
  addFilterToQuery,
  getFilterLabel,
} from "./search-query-parser"

describe("parseSearchQuery", () => {
  it("should parse query with no filters", () => {
    const result = parseSearchQuery("hello world")
    expect(result.filters).toEqual([])
    expect(result.text).toBe("hello world")
  })

  it("should parse from:@ filter", () => {
    const result = parseSearchQuery("from:@martin hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "from",
      value: "martin",
      raw: "from:@martin",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse in:# filter (channel)", () => {
    const result = parseSearchQuery("in:#general hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "in",
      value: "general",
      raw: "in:#general",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse in:@ filter (DM)", () => {
    const result = parseSearchQuery("in:@martin hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "in",
      value: "martin",
      raw: "in:@martin",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse status: filter", () => {
    const result = parseSearchQuery("status:active hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "status",
      value: "active",
      raw: "status:active",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse is: filter as type filter", () => {
    const result = parseSearchQuery("is:scratchpad hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "type",
      value: "scratchpad",
      raw: "is:scratchpad",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse type: filter", () => {
    const result = parseSearchQuery("type:channel hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "type",
      value: "channel",
      raw: "type:channel",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse after: filter", () => {
    const result = parseSearchQuery("after:2025-01-01 hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "after",
      value: "2025-01-01",
      raw: "after:2025-01-01",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse before: filter", () => {
    const result = parseSearchQuery("before:2025-12-31 hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "before",
      value: "2025-12-31",
      raw: "before:2025-12-31",
    })
    expect(result.text).toBe("hello")
  })

  it("should parse multiple filters", () => {
    const result = parseSearchQuery("from:@martin in:#general is:channel hello world")
    expect(result.filters).toHaveLength(3)
    expect(result.filters[0].type).toBe("from")
    expect(result.filters[1].type).toBe("in")
    expect(result.filters[2].type).toBe("type")
    expect(result.text).toBe("hello world")
  })

  it("should parse type: as alias for is:", () => {
    const result = parseSearchQuery("type:channel hello")
    expect(result.filters).toHaveLength(1)
    expect(result.filters[0]).toEqual({
      type: "type",
      value: "channel",
      raw: "type:channel",
    })
    expect(result.text).toBe("hello")
  })

  it("should handle filters with no text", () => {
    const result = parseSearchQuery("from:@martin in:#general")
    expect(result.filters).toHaveLength(2)
    expect(result.text).toBe("")
  })

  it("should handle text with filters in the middle", () => {
    const result = parseSearchQuery("hello from:@martin world")
    expect(result.filters).toHaveLength(1)
    expect(result.text).toBe("hello world")
  })

  it("should handle empty query", () => {
    const result = parseSearchQuery("")
    expect(result.filters).toEqual([])
    expect(result.text).toBe("")
  })

  it("should handle filter with empty value as text", () => {
    const result = parseSearchQuery("from:@ hello")
    expect(result.filters).toHaveLength(0)
    expect(result.text).toBe("from:@ hello")
  })
})

describe("serializeSearchQuery", () => {
  it("should build query from filters and text", () => {
    const filters = [
      { type: "from" as const, value: "martin", raw: "from:@martin" },
      { type: "in" as const, value: "general", raw: "in:#general" },
    ]
    const result = serializeSearchQuery(filters, "hello world")
    expect(result).toBe("from:@martin in:#general hello world")
  })

  it("should build query with filters only", () => {
    const filters = [{ type: "from" as const, value: "martin", raw: "from:@martin" }]
    const result = serializeSearchQuery(filters, "")
    expect(result).toBe("from:@martin")
  })

  it("should build query with text only", () => {
    const result = serializeSearchQuery([], "hello world")
    expect(result).toBe("hello world")
  })
})

describe("removeFilterFromQuery", () => {
  it("should remove filter by index", () => {
    const query = "from:@martin in:#general hello"
    const result = removeFilterFromQuery(query, 0)
    expect(result).toBe("in:#general hello")
  })

  it("should remove middle filter", () => {
    const query = "from:@martin in:#general type:channel hello"
    const result = removeFilterFromQuery(query, 1)
    expect(result).toBe("from:@martin type:channel hello")
  })

  it("should remove last filter", () => {
    const query = "from:@martin in:#general hello"
    const result = removeFilterFromQuery(query, 1)
    expect(result).toBe("from:@martin hello")
  })
})

describe("addFilterToQuery", () => {
  it("should add from filter", () => {
    const result = addFilterToQuery("hello", "from", "martin")
    expect(result).toBe("from:@martin hello")
  })

  it("should add status filter", () => {
    const result = addFilterToQuery("hello", "status", "active")
    expect(result).toBe("status:active hello")
  })

  it("should add type filter with is: prefix", () => {
    const result = addFilterToQuery("hello", "type", "channel")
    expect(result).toBe("is:channel hello")
  })

  it("should add after filter", () => {
    const result = addFilterToQuery("hello", "after", "2025-01-01")
    expect(result).toBe("after:2025-01-01 hello")
  })

  it("should add in filter for channel (with #)", () => {
    const result = addFilterToQuery("hello", "in", "#general")
    expect(result).toBe("in:#general hello")
  })

  it("should add in filter for DM (without #)", () => {
    const result = addFilterToQuery("hello", "in", "martin")
    expect(result).toBe("in:@martin hello")
  })
})

describe("getFilterLabel", () => {
  it("should return label for from filter", () => {
    const result = getFilterLabel({ type: "from", value: "martin", raw: "from:@martin" })
    expect(result).toBe("@martin")
  })

  it("should return label for in channel filter", () => {
    const result = getFilterLabel({ type: "in", value: "general", raw: "in:#general" })
    expect(result).toBe("#general")
  })

  it("should return label for in DM filter", () => {
    const result = getFilterLabel({ type: "in", value: "martin", raw: "in:@martin" })
    expect(result).toBe("@martin")
  })

  it("should return label for status filter", () => {
    const result = getFilterLabel({ type: "status", value: "active", raw: "status:active" })
    expect(result).toBe("active")
  })

  it("should return label for type filter", () => {
    const result = getFilterLabel({ type: "type", value: "channel", raw: "type:channel" })
    expect(result).toBe("channel")
  })

  it("should return label for after filter", () => {
    const result = getFilterLabel({ type: "after", value: "2025-01-01", raw: "after:2025-01-01" })
    expect(result).toBe("after 2025-01-01")
  })

  it("should return label for before filter", () => {
    const result = getFilterLabel({ type: "before", value: "2025-12-31", raw: "before:2025-12-31" })
    expect(result).toBe("before 2025-12-31")
  })
})
