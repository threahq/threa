#!/usr/bin/env bun
// Build a self-contained standalone install of the Threa Pi remote extension.
//
// Inside the monorepo, `@threahq/bot-runtime-client` and `@threa/harness-client`
// resolve via sibling `file:` deps. The install target
// (~/.pi/agent/extensions/threa-remote) has no siblings and harness-client is
// private (not on npm), so a plain copy + `bun install` can't resolve them. We
// vendor both packages' runtime source into the copy and drop the deps. Their
// only runtime dependency, socket.io-client, is already a direct dependency here.
//
// Usage: bun run extensions/pi-remote/install-local.ts [destDir]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url)) // extensions/pi-remote
const extensionsDir = join(homedir(), ".pi", "agent", "extensions")
const dest = process.argv[2] ?? join(extensionsDir, "threa-remote")

// Vendored sibling packages: dep specifier → source dir + runtime files (tests
// are not needed at runtime).
const VENDORED = [
  {
    dep: "@threahq/bot-runtime-client",
    src: resolve(here, "../bot-runtime-client"),
    files: [
      "index.ts",
      "transport.ts",
      "types.ts",
      "ws-hint.ts",
      "crypto.ts",
      "sealed.ts",
      "archive-grace.ts",
      "attachment-files.ts",
    ],
    dir: "bot-runtime-client",
  },
  {
    dep: "@threa/harness-client",
    src: resolve(here, "../harness-client"),
    files: [
      "index.ts",
      "supervisor.ts",
      "harness-kick.ts",
      "harness-reconnect.ts",
      "tmux-key.ts",
      "tmux-window.ts",
      "harness-links.ts",
    ],
    dir: "harness-client",
  },
]

// 1. Clean any prior install — both the legacy single-file form and the dir form.
rmSync(join(extensionsDir, "threa-remote.ts"), { force: true })
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

// 2. Copy the extension, minus install-time cruft. bun.lock is regenerated below;
//    node_modules and this script must not ship into the install.
cpSync(here, dest, {
  recursive: true,
  filter: (src) => !/\/(node_modules|bun\.lock|install-local\.ts)$/.test(src),
})

// 3. Vendor each package's runtime source, then check every relative import in
//    the vendored copies resolves inside the copy: a file added to a package and
//    re-exported from its index but missing from `files` produces an install
//    that cannot even be imported, and nothing notices until someone reloads Pi.
const vendorRoot = join(dest, "src", "vendor")
for (const pkg of VENDORED) {
  const vendorDir = join(vendorRoot, pkg.dir)
  mkdirSync(vendorDir, { recursive: true })
  for (const f of pkg.files) cpSync(join(pkg.src, "src", f), join(vendorDir, f))
}

const missingImports: string[] = []
const relativeImportPattern = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'](\.\.?\/[^"']+)["']/g
for (const pkg of VENDORED) {
  const vendorDir = join(vendorRoot, pkg.dir)
  for (const file of pkg.files) {
    const source = readFileSync(join(vendorDir, file), "utf8")
    for (const [, specifier] of source.matchAll(relativeImportPattern)) {
      const target = resolve(dirname(join(vendorDir, file)), specifier)
      if (![target, `${target}.ts`, join(target, "index.ts")].some(existsSync)) {
        missingImports.push(`${pkg.dep}/${file} imports ${specifier}`)
      }
    }
  }
}
if (missingImports.length > 0) {
  throw new Error(`vendored packages are incomplete:\n  ${missingImports.join("\n  ")}`)
}

// 4. Repoint every import of the vendored deps at the vendored copies — in the
//    extension source AND between the vendored packages themselves
//    (harness-client imports bot-runtime-client).
let rewrites = 0
const walk = (dir: string) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(p)
      continue
    }
    if (!ent.name.endsWith(".ts")) continue
    let code = readFileSync(p, "utf8")
    let changed = false
    for (const pkg of VENDORED) {
      if (!code.includes(pkg.dep)) continue
      const entry = join(vendorRoot, pkg.dir, "index.ts")
      let spec = relative(dirname(p), entry).replace(/\.ts$/, "")
      if (!spec.startsWith(".")) spec = `./${spec}`
      code = code.replaceAll(`"${pkg.dep}"`, `"${spec}"`).replaceAll(`'${pkg.dep}'`, `'${spec}'`)
      changed = true
    }
    if (changed) {
      writeFileSync(p, code)
      rewrites++
    }
  }
}
walk(join(dest, "src"))
if (rewrites === 0) {
  throw new Error("import rewrite failed: no vendored dep specifiers found under src/")
}

// 5. Drop the now-vendored deps from the copied package.json, and inherit the
//    vendored packages' own runtime deps (@hpke/*, ulid for the sealed path) so
//    the standalone install can resolve them without the workspace.
const pkgPath = join(dest, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
for (const vendored of VENDORED) {
  delete pkg.dependencies?.[vendored.dep]
  const vendoredPkg = JSON.parse(readFileSync(join(vendored.src, "package.json"), "utf8"))
  for (const [dep, version] of Object.entries(vendoredPkg.dependencies ?? {})) {
    if (VENDORED.some((entry) => entry.dep === dep)) continue
    pkg.dependencies[dep] ??= version
  }
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// 6. Install the remaining deps in the standalone copy.
const result = spawnSync("bun", ["install"], { cwd: dest, stdio: "inherit" })
if (result.status !== 0) process.exit(result.status ?? 1)

console.log(`\nInstalled to ${dest}\nRun /reload in Pi.`)
