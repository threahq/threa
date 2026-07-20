import { describe, expect, test } from "bun:test"
import { computeDescendants, parseProcessTable } from "./dev-lifecycle"

describe("parseProcessTable", () => {
  test("parses ps pid/ppid output, skipping malformed lines", () => {
    const output = ["    1     0", "  100     1", " 4523   100", "", "PID PPID", "abc def"].join("\n")
    expect(parseProcessTable(output)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 1 },
      { pid: 4523, ppid: 100 },
    ])
  })
})

describe("computeDescendants", () => {
  const rows = [
    { pid: 10, ppid: 1 }, // dev.ts
    { pid: 20, ppid: 10 }, // bunx wrangler
    { pid: 21, ppid: 20 }, // workerd
    { pid: 30, ppid: 10 }, // bun run frontend
    { pid: 31, ppid: 30 }, // vite (node)
    { pid: 99, ppid: 1 }, // unrelated process
  ]

  test("returns full tree deepest-first, roots last", () => {
    const order = computeDescendants(rows, [20, 30])
    expect(order).toEqual([21, 20, 31, 30])
  })

  test("never includes processes outside the given roots", () => {
    expect(computeDescendants(rows, [20])).not.toContain(99)
    expect(computeDescendants(rows, [20])).not.toContain(10)
  })

  test("root with no children returns just the root", () => {
    expect(computeDescendants(rows, [99])).toEqual([99])
  })

  test("tolerates pid cycles without infinite loop", () => {
    const cyclic = [
      { pid: 5, ppid: 6 },
      { pid: 6, ppid: 5 },
    ]
    expect(computeDescendants(cyclic, [5])).toEqual([6, 5])
  })
})
