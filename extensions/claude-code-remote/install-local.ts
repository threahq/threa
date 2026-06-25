#!/usr/bin/env bun
// Build a self-contained standalone install of the Threa Claude Code channel.
//
// Inside the monorepo, `@threa/bot-runtime-client` resolves via the sibling
// `file:../bot-runtime-client`. Running the channel from outside a monorepo checkout
// (registering `bun <abs path>/src/index.ts` from a box that has no threa clone) has no
// sibling and the package is private (not on npm), so a plain copy + `bun install` can't
// resolve it. We vendor bot-runtime-client's source into the copy and drop the dep. Its
// only runtime dependency, socket.io-client, is already a direct dependency here.
//
// Usage: bun run extensions/claude-code-remote/install-local.ts [destDir]

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url)) // extensions/claude-code-remote
const botRuntime = resolve(here, "../bot-runtime-client")
const dest = process.argv[2] ?? join(homedir(), ".threa", "claude-code-remote")

const DEP = "@threa/bot-runtime-client"
// The runtime files of bot-runtime-client (its tests are not needed at runtime).
const VENDOR_FILES = ["index.ts", "transport.ts", "types.ts", "ws-hint.ts"]

// 1. Clean any prior install.
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

// 2. Copy the channel, minus install-time cruft. bun.lock is regenerated below;
//    node_modules and this script must not ship into the install.
cpSync(here, dest, {
  recursive: true,
  filter: (src) => !/\/(node_modules|bun\.lock|install-local\.ts)$/.test(src),
})

// 3. Vendor bot-runtime-client's runtime source.
const vendor = join(dest, "src", "vendor", "bot-runtime-client")
mkdirSync(vendor, { recursive: true })
for (const f of VENDOR_FILES) cpSync(join(botRuntime, "src", f), join(vendor, f))

// 4. Repoint every import of the dep at the vendored copy. The channel references it from
//    more than one file (channel-server.ts and its test), so rewrite all copied sources;
//    the specifier is computed per file so nested files resolve correctly too.
const vendorEntry = join(vendor, "index.ts")
let rewrites = 0
const walk = (dir: string) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (p !== vendor) walk(p) // never rewrite the vendored source itself
      continue
    }
    if (!ent.name.endsWith(".ts")) continue
    const code = readFileSync(p, "utf8")
    if (!code.includes(DEP)) continue
    let spec = relative(dirname(p), vendorEntry).replace(/\.ts$/, "")
    if (!spec.startsWith(".")) spec = `./${spec}`
    const rewritten = code.replaceAll(`"${DEP}"`, `"${spec}"`).replaceAll(`'${DEP}'`, `'${spec}'`)
    if (rewritten !== code) {
      writeFileSync(p, rewritten)
      rewrites++
    }
  }
}
walk(join(dest, "src"))
if (rewrites === 0) {
  throw new Error(`import rewrite failed: '${DEP}' specifier not found under src/`)
}

// 5. Drop the now-vendored dep from the copied package.json.
const pkgPath = join(dest, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
delete pkg.dependencies?.[DEP]
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// 6. Install the remaining deps (@modelcontextprotocol/sdk, socket.io-client, zod).
const result = spawnSync("bun", ["install"], { cwd: dest, stdio: "inherit" })
if (result.status !== 0) process.exit(result.status ?? 1)

const entry = join(dest, "src", "index.ts")
console.log(`\nInstalled to ${dest}\n`)
console.log("Register it with Claude Code (path must be absolute):")
console.log(`  claude mcp add threa --scope local -- bun ${entry}`)
console.log("Then launch:")
console.log("  claude --dangerously-load-development-channels server:threa")
