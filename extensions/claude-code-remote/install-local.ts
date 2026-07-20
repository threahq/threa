#!/usr/bin/env bun
// Build a self-contained standalone install of the Threa Claude Code channel.
//
// Inside the monorepo, `@threa/remote-session` and `@threa/bot-runtime-client`
// resolve via sibling `file:` deps. Running the channel from outside a monorepo
// checkout (registering `bun <abs path>/src/index.ts` from a box that has no
// threa clone) has no siblings and the packages are private (not on npm), so a
// plain copy + `bun install` can't resolve them. We vendor both packages'
// runtime source into the copy and drop the deps. Their only runtime
// dependency, socket.io-client, is already a direct dependency here.
//
// Usage: bun run extensions/claude-code-remote/install-local.ts [destDir]

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url)) // extensions/claude-code-remote
const dest = process.argv[2] ?? join(homedir(), ".threa", "claude-code-remote")

// Vendored sibling packages: dep specifier → source dir + runtime files (tests
// are not needed at runtime).
const VENDORED = [
  {
    dep: "@threa/bot-runtime-client",
    src: resolve(here, "../bot-runtime-client"),
    files: [
      "index.ts",
      "transport.ts",
      "types.ts",
      "ws-hint.ts",
      "crypto.ts",
      "sealed.ts",
      "supervisor.ts",
      "harness-kick.ts",
    ],
    dir: "bot-runtime-client",
  },
  {
    dep: "@threa/remote-session",
    src: resolve(here, "../remote-session"),
    files: [
      "index.ts",
      "session.ts",
      "client.ts",
      "identity.ts",
      "attachments.ts",
      "lifecycle.ts",
      "delegation-client.ts",
      "delegation-runner.ts",
    ],
    dir: "remote-session",
  },
]

// 1. Clean any prior install.
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

// 2. Copy the channel, minus install-time cruft. bun.lock is regenerated below;
//    node_modules and this script must not ship into the install.
cpSync(here, dest, {
  recursive: true,
  filter: (src) => !/\/(node_modules|bun\.lock|install-local\.ts)$/.test(src),
})

// 3. Vendor each package's runtime source.
const vendorRoot = join(dest, "src", "vendor")
for (const pkg of VENDORED) {
  const vendorDir = join(vendorRoot, pkg.dir)
  mkdirSync(vendorDir, { recursive: true })
  for (const f of pkg.files) cpSync(join(pkg.src, "src", f), join(vendorDir, f))
}

// 4. Repoint every import of the vendored deps at the vendored copies — in the
//    channel sources AND between the vendored packages themselves
//    (remote-session imports bot-runtime-client). The specifier is computed per
//    file so nested files resolve correctly.
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
//    the standalone install resolves them without the workspace.
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

// 6. Install the remaining deps (@modelcontextprotocol/sdk, socket.io-client, zod, @hpke/*, ulid).
const result = spawnSync("bun", ["install"], { cwd: dest, stdio: "inherit" })
if (result.status !== 0) process.exit(result.status ?? 1)

const entry = join(dest, "src", "index.ts")
console.log(`\nInstalled to ${dest}\n`)
console.log("Register it with Claude Code (path must be absolute):")
console.log(`  claude mcp add threa-channel --scope local -e THREA_CHANNEL_SERVER_KEY=threa-channel -- bun ${entry}`)
console.log("Then launch:")
console.log("  claude --dangerously-load-development-channels server:threa-channel")
