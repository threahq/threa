import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const SRC = resolve(__dirname)
const IMPORT = /(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

function resolveLocal(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier)
  else return null
  base = base.replace(/\?.*$/, "")
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

/** Local modules the worker bundle holds: static imports and dynamic ones, which the build inlines. */
function serviceWorkerModules(): string[] {
  const seen = new Set<string>()
  const pending = [join(SRC, "sw.ts")]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const next = resolveLocal(file, match[1] ?? match[2])
      if (next) pending.push(next)
    }
  }
  return [...seen].map((file) => relative(SRC, file)).sort()
}

describe("service worker module graph", () => {
  // A component module touches `document` at module scope; inside the worker
  // that throws while `sw.js` evaluates, the install fails, and the app loses
  // offline reload and `navigator.serviceWorker.ready` never resolves.
  it("should hold no React component modules (checks import shape, not evaluation)", () => {
    expect(serviceWorkerModules().filter((file) => file.endsWith(".tsx"))).toEqual([])
  })
})
