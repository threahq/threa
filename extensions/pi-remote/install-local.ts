#!/usr/bin/env bun
// Build a self-contained standalone install of the Threa Pi remote extension.
//
// Inside the monorepo, `@threa/bot-runtime-client` resolves via the sibling
// `file:../bot-runtime-client`. The install target (~/.pi/agent/extensions/threa-remote)
// has no sibling and the package is private (not on npm), so a plain copy + `bun install`
// can't resolve it. We vendor bot-runtime-client's source into the copy and drop the dep.
// Its only runtime dependency, socket.io-client, is already a direct dependency here.
//
// Usage: bun run extensions/pi-remote/install-local.ts [destDir]

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url)) // extensions/pi-remote
const botRuntime = resolve(here, "../bot-runtime-client")
const extensionsDir = join(homedir(), ".pi", "agent", "extensions")
const dest = process.argv[2] ?? join(extensionsDir, "threa-remote")

// The runtime files of bot-runtime-client (its tests are not needed at runtime).
const VENDOR_FILES = [
  "index.ts",
  "transport.ts",
  "types.ts",
  "ws-hint.ts",
  "crypto.ts",
  "sealed.ts",
  "supervisor.ts",
  "harness-kick.ts",
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

// 3. Vendor bot-runtime-client's runtime source.
const vendor = join(dest, "src", "vendor", "bot-runtime-client")
mkdirSync(vendor, { recursive: true })
for (const f of VENDOR_FILES) cpSync(join(botRuntime, "src", f), join(vendor, f))

// 4. Point the import at the vendored copy.
const entry = join(dest, "src", "threa-remote.ts")
const code = readFileSync(entry, "utf8")
const rewritten = code.replace(/from ["']@threa\/bot-runtime-client["']/, 'from "./vendor/bot-runtime-client/index"')
if (rewritten === code) {
  throw new Error("import rewrite failed: '@threa/bot-runtime-client' specifier not found in src/threa-remote.ts")
}
writeFileSync(entry, rewritten)

// 5. Drop the now-vendored dep from the copied package.json, and inherit the
//    vendored source's own runtime deps (@hpke/*, ulid for the sealed path) so
//    the standalone install can resolve them without the workspace.
const pkgPath = join(dest, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
delete pkg.dependencies?.["@threa/bot-runtime-client"]
const botRuntimePkg = JSON.parse(readFileSync(join(botRuntime, "package.json"), "utf8"))
pkg.dependencies = { ...(botRuntimePkg.dependencies ?? {}), ...pkg.dependencies }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// 6. Install the remaining deps in the standalone copy.
const result = spawnSync("bun", ["install"], { cwd: dest, stdio: "inherit" })
if (result.status !== 0) process.exit(result.status ?? 1)

console.log(`\nInstalled to ${dest}\nRun /reload in Pi.`)
