import { describe, expect, it } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"
import { AI_USAGE_CATEGORIES } from "@threahq/types"
import { AI_FUNCTIONS, categorizeFunction, aggregateUsageByDay } from "./categories"

describe("categorizeFunction", () => {
  it("maps a representative id from each category", () => {
    expect(categorizeFunction("memorize-conversation")).toBe("memory")
    expect(categorizeFunction("boundary-extraction")).toBe("conversation")
    expect(categorizeFunction("agent-loop")).toBe("agents")
    expect(categorizeFunction("pdf-summary")).toBe("attachments")
    expect(categorizeFunction("stream-naming")).toBe("other")
  })

  it('falls back to "other" for an unknown id', () => {
    expect(categorizeFunction("totally-unknown-fn")).toBe("other")
  })

  it("only maps to declared categories", () => {
    for (const { category } of Object.values(AI_FUNCTIONS)) {
      expect(AI_USAGE_CATEGORIES).toContain(category)
    }
  })
})

describe("AI_FUNCTIONS", () => {
  // An id missing here is gated as an agent call, so background work would stop
  // at the agents cutoff instead of its own.
  it("should list every functionId literal in production source", async () => {
    const repoRoot = join(import.meta.dir, "../../../../..")
    const found = new Set<string>()
    for (const pattern of ["apps/backend/src/**/*.ts", "packages/agent-runtime/src/**/*.ts"]) {
      for await (const file of new Glob(pattern).scan(repoRoot)) {
        if (file.endsWith(".test.ts")) continue
        const text = await Bun.file(join(repoRoot, file)).text()
        for (const match of text.matchAll(/functionId:\s*"([^"]+)"/g)) found.add(match[1])
      }
    }
    // Callers that omit an id fall back to these.
    found.add("embedding-single").add("embedding-batch")

    expect([...found].filter((id) => !(id in AI_FUNCTIONS))).toEqual([])
  })
})

describe("aggregateUsageByDay", () => {
  it("sums cost/tokens/count per (date, category) and sorts by date then category", () => {
    const result = aggregateUsageByDay([
      { date: "2026-07-02", functionId: "agent-loop", totalCostUsd: 1, totalTokens: 100, recordCount: 2 },
      { date: "2026-07-01", functionId: "memo-embedding", totalCostUsd: 0.5, totalTokens: 50, recordCount: 1 },
      { date: "2026-07-01", functionId: "memorize-conversation", totalCostUsd: 0.25, totalTokens: 20, recordCount: 3 },
      { date: "2026-07-01", functionId: "agent-loop", totalCostUsd: 2, totalTokens: 200, recordCount: 4 },
    ])

    expect(result).toEqual([
      { date: "2026-07-01", category: "agents", totalCostUsd: 2, totalTokens: 200, recordCount: 4 },
      { date: "2026-07-01", category: "memory", totalCostUsd: 0.75, totalTokens: 70, recordCount: 4 },
      { date: "2026-07-02", category: "agents", totalCostUsd: 1, totalTokens: 100, recordCount: 2 },
    ])
  })

  it("returns an empty array for no rows", () => {
    expect(aggregateUsageByDay([])).toEqual([])
  })
})
