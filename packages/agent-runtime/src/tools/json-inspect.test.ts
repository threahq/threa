import { describe, it, expect } from "bun:test"
import { applySelect, describeShape, structuralPreview, typeName } from "./json-inspect"

describe("json-inspect", () => {
  describe("typeName", () => {
    it("names primitives, arrays, objects, and null", () => {
      expect(typeName(null)).toBe("null")
      expect(typeName([])).toBe("array")
      expect(typeName({})).toBe("object")
      expect(typeName("x")).toBe("string")
      expect(typeName(1)).toBe("number")
      expect(typeName(true)).toBe("boolean")
    })
  })

  describe("describeShape", () => {
    it("collapses arrays to a length + inline element shape", () => {
      const value = {
        data: {
          items: [
            { id: "a", name: "Apple", price: 1 },
            { id: "b", name: "Banana", price: 2 },
          ],
          total: 2,
          nextCursor: null,
        },
      }
      expect(describeShape(value)).toEqual({
        data: {
          items: "array[2] of {id:string, name:string, price:number}",
          total: "number",
          nextCursor: "null",
        },
      })
    })

    it("describes a top-level array", () => {
      expect(describeShape([1, 2, 3])).toBe("array[3] of number")
      expect(describeShape([])).toBe("array[0]")
    })

    it("caps the number of object keys it expands", () => {
      const wide: Record<string, number> = {}
      for (let i = 0; i < 60; i++) wide[`k${i}`] = i
      const shape = describeShape(wide) as Record<string, unknown>
      expect(shape["…"]).toBe("(10 more keys)")
    })
  })

  describe("structuralPreview", () => {
    it("samples long arrays and reports how many were dropped", () => {
      const value = Array.from({ length: 1043 }, (_, i) => ({ id: i }))
      const preview = structuralPreview(value) as unknown[]
      expect(preview.length).toBe(4) // 3 samples + summary marker
      expect(preview[3]).toBe("…(1040 more items)")
      expect(preview[0]).toEqual({ id: 0 })
    })

    it("truncates long strings but keeps the total length", () => {
      const value = { blob: "x".repeat(5000) }
      const preview = structuralPreview(value) as { blob: string }
      expect(preview.blob).toContain("…(5000 chars total)")
      expect(preview.blob.length).toBeLessThan(5000)
    })

    it("caps wide objects", () => {
      const wide: Record<string, number> = {}
      for (let i = 0; i < 40; i++) wide[`k${i}`] = i
      const preview = structuralPreview(wide) as Record<string, unknown>
      expect(preview["…"]).toBe("(10 more keys)")
    })

    it("leaves small data untouched", () => {
      const value = { a: 1, b: [true, false], c: "hi" }
      expect(structuralPreview(value)).toEqual(value)
    })

    it("truncates pathologically long key names", () => {
      const longKey = "k".repeat(500)
      const preview = structuralPreview({ [longKey]: 1 }) as Record<string, unknown>
      const outKey = Object.keys(preview)[0]!
      expect(outKey.length).toBeLessThan(500)
      expect(outKey).toContain("…(500 chars)")
    })
  })

  describe("applySelect", () => {
    const doc = {
      data: {
        items: [
          { id: "a", name: "Apple", tags: ["fruit", "red"] },
          { id: "b", name: "Banana", tags: ["fruit", "yellow"] },
          { id: "c", name: "Cherry", tags: ["fruit", "red"] },
        ],
        total: 3,
      },
      "weird key": 42,
    }

    it("resolves a dotted key path", () => {
      expect(applySelect(doc, ".data.total")).toEqual({ value: 3 })
    })

    it("tolerates a leading bare key and a $ root", () => {
      expect(applySelect(doc, "data.total")).toEqual({ value: 3 })
      expect(applySelect(doc, "$.data.total")).toEqual({ value: 3 })
    })

    it("indexes into arrays", () => {
      expect(applySelect(doc, ".data.items[1].name")).toEqual({ value: "Banana" })
    })

    it("supports negative indices", () => {
      expect(applySelect(doc, ".data.items[-1].name")).toEqual({ value: "Cherry" })
    })

    it("slices arrays", () => {
      const r = applySelect(doc, ".data.items[0:2]") as { value: unknown[] }
      expect(r.value).toHaveLength(2)
      expect((r.value[0] as { id: string }).id).toBe("a")
    })

    it("supports open-ended slices", () => {
      const r = applySelect(doc, ".data.items[1:]") as { value: unknown[] }
      expect(r.value).toHaveLength(2)
    })

    it("maps a field over a wildcard", () => {
      expect(applySelect(doc, ".data.items[*].name")).toEqual({ value: ["Apple", "Banana", "Cherry"] })
    })

    it("resolves quoted keys with special characters", () => {
      expect(applySelect(doc, '["weird key"]')).toEqual({ value: 42 })
    })

    it("null-fills wildcard elements missing a field but keeps the ones present", () => {
      const heterogeneous = { users: [{ email: "a@x.com" }, { name: "no email" }, { email: "c@x.com" }] }
      expect(applySelect(heterogeneous, ".users[*].email")).toEqual({ value: ["a@x.com", null, "c@x.com"] })
    })

    it("errors on a wildcard path when no element matches", () => {
      const heterogeneous = { users: [{ name: "x" }, { name: "y" }] }
      const r = applySelect(heterogeneous, ".users[*].email") as { error: string }
      expect(r.error).toContain("'email' not found")
    })

    it("errors with available keys on a missing key", () => {
      const r = applySelect(doc, ".data.missing") as { error: string }
      expect(r.error).toContain("'missing' not found")
      expect(r.error).toContain("items")
      expect(r.error).toContain("total")
    })

    it("errors when indexing a non-array", () => {
      const r = applySelect(doc, ".data[0]") as { error: string }
      expect(r.error).toContain("not an array")
    })

    it("errors when reading a key from a non-object", () => {
      const r = applySelect(doc, ".data.total.nope") as { error: string }
      expect(r.error).toContain("not an object")
    })

    it("errors on out-of-range index", () => {
      const r = applySelect(doc, ".data.items[99]") as { error: string }
      expect(r.error).toContain("out of range")
    })

    it("errors on a malformed selector", () => {
      expect(applySelect(doc, "")).toHaveProperty("error")
      expect(applySelect(doc, ".data.items[")).toHaveProperty("error")
    })
  })
})
