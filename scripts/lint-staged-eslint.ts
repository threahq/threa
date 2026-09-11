/**
 * Run each app's own pinned eslint over its staged files, from inside the app.
 *
 * A flat config's `files` globs resolve against the working directory, and
 * eslint 9 looks the config up there too — so an app binary invoked from the
 * repo root either finds no config at all or matches nothing in the one it is
 * handed. The apps sit on different eslint majors, so the cwd is the only fix
 * that holds for all of them.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const byApp = new Map<string, string[]>()

for (const file of process.argv.slice(2)) {
  const path = relative(root, resolve(file))
  const app = path.match(/^(apps\/[^/]+)\//)?.[1]
  if (!app) continue
  byApp.set(app, [...(byApp.get(app) ?? []), relative(app, path)])
}

let failed = false
for (const [app, files] of byApp) {
  const binary = resolve(root, app, "node_modules/.bin/eslint")
  if (!existsSync(binary)) {
    console.error(`${app} has no eslint installed — run \`bun install\` in it`)
    failed = true
    continue
  }
  const result = spawnSync(binary, files, { cwd: resolve(root, app), stdio: "inherit" })
  if (result.status !== 0) failed = true
}

process.exit(failed ? 1 : 0)
