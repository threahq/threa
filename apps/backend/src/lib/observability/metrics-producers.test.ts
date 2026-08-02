import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** A metric with no writer is exposed forever at zero, which reads as a real observation. */

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url)).replace(/\/$/, "")
const METRICS_FILE = join(REPO_ROOT, "apps/backend/src/lib/observability/metrics.ts")
const BARREL_FILE = join(REPO_ROOT, "apps/backend/src/lib/observability/index.ts")
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"])

function scanRoots(): string[] {
  const roots = [join(REPO_ROOT, "apps/backend/src")]
  const packagesDir = join(REPO_ROOT, "packages")
  for (const pkg of readdirSync(packagesDir).sort()) {
    const src = join(packagesDir, pkg, "src")
    try {
      if (statSync(src).isDirectory()) roots.push(src)
    } catch {
      // package without a src/ tree
    }
  }
  return roots
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
      continue
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue
    if (full === METRICS_FILE || full === BARREL_FILE) continue
    out.push(full)
  }
}

function definedMetrics(): string[] {
  const source = readFileSync(METRICS_FILE, "utf8")
  const names: string[] = []
  for (const match of source.matchAll(/export const (\w+) = new (?:Gauge|Counter|Histogram|Summary)\b/g)) {
    names.push(match[1])
  }
  return names.sort()
}

describe("observability metrics", () => {
  test("every registered metric has a producer", () => {
    const metrics = definedMetrics()
    expect(metrics.length).toBeGreaterThan(0)

    const files: string[] = []
    for (const root of scanRoots()) walk(root, files)
    files.sort()

    const referenced = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const name of metrics) {
        if (referenced.has(name)) continue
        if (new RegExp(`\\b${name}\\s*\\.\\s*(inc|dec|set|observe|startTimer)\\b`).test(source)) referenced.add(name)
      }
    }

    expect(metrics.filter((name) => !referenced.has(name))).toEqual([])
  })
})
