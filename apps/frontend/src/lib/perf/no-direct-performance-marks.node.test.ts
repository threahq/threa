import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// All performance instrumentation goes through `lib/perf` — the facade is what
// keeps the emitted mark names a closed set (`PERF_MARK_NAMES`), keeps free
// text out of samples, and keeps the whole thing inert when unarmed. A direct
// `performance.mark`/`measure` or a hand-rolled PerformanceObserver bypasses
// all three at once, so it fails here rather than at review time.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const perfDir = resolve(dirname(fileURLToPath(import.meta.url)))

/** Files allowed to touch the browser performance API directly, with the reason. */
const allowlist = new Set<string>([
  // (empty — lib/perf itself is excluded by directory, not by entry)
])

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe("performance instrumentation goes through lib/perf", () => {
  it("has no direct performance.mark/measure or PerformanceObserver outside lib/perf", () => {
    const violations: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      if (file.startsWith(perfDir)) continue
      const rel = relative(srcRoot, file)
      if (allowlist.has(rel)) continue

      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (/\bperformance\.(mark|measure)\s*\(/.test(line) || /\bnew PerformanceObserver\s*\(/.test(line)) {
          violations.push(`${rel}:${i + 1}`)
        }
      })
    }

    expect(
      violations,
      `Direct performance-API use outside lib/perf. Route the measurement through ` +
        `\`getPerfCapture()\` / \`usePerfCapture()\` with a name from PERF_MARK_NAMES, ` +
        `or add the file to the allowlist with a reason:\n${violations.join("\n")}`
    ).toEqual([])
  })
})
