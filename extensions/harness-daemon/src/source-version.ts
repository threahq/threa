import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

/** The daemon runs its TypeScript straight from the checkout, so "its source" is its own tree plus every workspace package it links by path. */
export function daemonSourceRoots(packageDir = resolve(import.meta.dir, "..")): string[] {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }
  const roots = [join(packageDir, "src")]
  for (const spec of Object.values(manifest.dependencies ?? {})) {
    if (spec.startsWith("file:")) roots.push(join(resolve(packageDir, spec.slice("file:".length)), "src"))
  }
  return roots.filter((root) => existsSync(root))
}

/** Content, not mtime: a checkout that rewrites a file back to what it already said must not count as new code. */
export function fingerprintSources(roots: string[]): string {
  const parts: string[] = []
  for (const root of roots) collect(root, parts)
  parts.sort()
  return Bun.hash(parts.join("\n")).toString(16)
}

function collect(dir: string, parts: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      collect(path, parts)
      continue
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
    parts.push(`${path}\t${Bun.hash(readFileSync(path)).toString(16)}`)
  }
}

/**
 * True once the tree has both moved away from what this process loaded and
 * stopped moving. Two readings, not one: a pull or a checkout rewrites the tree
 * file by file, and restarting into a half-written tree is the failure this
 * guards, not the one it fixes.
 */
export function createSourceChangeWatch(fingerprint: () => string = defaultFingerprint): () => boolean {
  const booted = fingerprint()
  let previous = booted
  return () => {
    const current = fingerprint()
    const settled = current !== booted && current === previous
    previous = current
    return settled
  }
}

function defaultFingerprint(): string {
  return fingerprintSources(daemonSourceRoots())
}
