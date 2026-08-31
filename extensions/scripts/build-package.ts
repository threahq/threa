#!/usr/bin/env bun
// Build the publishable form of an extension package into its dist/.
//
// Inside the repo every extension resolves its siblings through `file:` deps
// and runs straight from src/, so the source package.json points at
// src/index.ts. The published package must instead ship compiled ESM plus type
// declarations and depend on its siblings by version, so this script writes a
// complete package directory (index.js, index.d.ts, package.json, README,
// LICENSE) and `npm pack`/`npm publish` run against dist/ — the tarball is the
// product, and nothing in-repo has to change shape to produce it.
//
// Sibling packages resolve through `paths` in tsconfig.build.json to the
// sibling's built dist/, so a build needs no per-package `bun install` (Bun 1.4
// refuses the transitive relative `file:` chain) — only the root node_modules
// and the siblings built first, in dependency order.
//
// Usage (from the package directory): bun ../scripts/build-package.ts

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const pkgDir = process.cwd()
const repoRoot = resolve(pkgDir, "..", "..")
const dist = join(pkgDir, "dist")
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))

if (pkg.private) throw new Error(`${pkg.name} is private; nothing to publish`)
if (!existsSync(join(pkgDir, "README.md"))) throw new Error(`${pkg.name} has no README.md`)

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { cwd: pkgDir, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? "signal"})`)
  }
}

// One ESM bundle of this package's own source; every dependency stays external
// so the consumer's package manager resolves it (and dedupes it).
run("bun", [
  "build",
  "src/index.ts",
  "--outdir",
  dist,
  "--target",
  "node",
  "--format",
  "esm",
  "--packages",
  "external",
  "--sourcemap=linked",
])
run(join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"])

// Source imports are extensionless (Bun and `moduleResolution: bundler` accept
// that); the emitted declarations must carry `.js` so `node16`/`nodenext`
// consumers resolve them too.
for (const file of readdirSync(dist).filter((name) => name.endsWith(".d.ts"))) {
  const path = join(dist, file)
  const rewritten = readFileSync(path, "utf8").replace(
    /((?:from\s+|import\()\s*["'])(\.\.?\/[^"']+?)(["'])/g,
    (match, open, specifier, close) => (/\.[cm]?js$/.test(specifier) ? match : `${open}${specifier}.js${close}`)
  )
  writeFileSync(path, rewritten)
}

// `file:../sibling` deps become a caret range on the sibling's own version.
function publishedDeps(deps: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!deps) return undefined
  return Object.fromEntries(
    Object.entries(deps).map(([name, spec]) => {
      if (!spec.startsWith("file:")) return [name, spec]
      const sibling = JSON.parse(readFileSync(join(pkgDir, spec.slice("file:".length), "package.json"), "utf8"))
      if (sibling.private) throw new Error(`${pkg.name} depends on private package ${sibling.name}`)
      return [name, `^${sibling.version}`]
    })
  )
}

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  type: "module",
  sideEffects: false,
  main: "./index.js",
  types: "./index.d.ts",
  exports: { ".": { types: "./index.d.ts", import: "./index.js" }, "./package.json": "./package.json" },
  engines: pkg.engines,
  dependencies: publishedDeps(pkg.dependencies),
  peerDependencies: pkg.peerDependencies,
  publishConfig: { access: "public" },
}
const OPTIONAL = new Set(["dependencies", "peerDependencies"])
for (const [key, value] of Object.entries(manifest)) {
  if (value !== undefined) continue
  if (!OPTIONAL.has(key)) throw new Error(`${pkg.name}: package.json is missing "${key}"`)
  delete manifest[key as keyof typeof manifest]
}
writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(pkgDir, "README.md"), join(dist, "README.md"))
cpSync(join(repoRoot, "LICENSE"), join(dist, "LICENSE"))
// The README links to examples/; ship them so the links hold in node_modules.
if (existsSync(join(pkgDir, "examples"))) cpSync(join(pkgDir, "examples"), join(dist, "examples"), { recursive: true })

console.log(`built ${pkg.name}@${pkg.version} → ${basename(pkgDir)}/dist`)
