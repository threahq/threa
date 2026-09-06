#!/usr/bin/env bun
/**
 * Lint: every package.json is either unpublishable (`"private": true`) or one of
 * the extensions `publish-npm.yml` ships, under `@threahq` — the only npm scope
 * we own.
 *
 * The drift this catches already happened once: the extensions moved to
 * `@threahq` when they went out and the other 23 packages kept `@threa`, an
 * account we cannot write to, while staying publishable.
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SCOPE = "@threahq/"
const PACKAGE_GLOBS = ["apps/*/package.json", "packages/*/package.json", "extensions/*/package.json"]

async function findPackageJsons(): Promise<string[]> {
  const paths: string[] = []
  for (const pattern of PACKAGE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) paths.push(path)
  }
  return paths.sort()
}

async function findPublishable(): Promise<Set<string>> {
  const workflow = await readFile(resolve(REPO_ROOT, ".github/workflows/publish-npm.yml"), "utf-8")
  const choices = workflow.match(/^\s*options:\n((?:\s*- \S+\n)+)/m)
  if (!choices) throw new Error("publish-npm.yml no longer lists its packages as workflow_dispatch choices")
  return new Set([...choices[1].matchAll(/- (\S+)/g)].map(([, dir]) => `extensions/${dir}/package.json`))
}

async function main(): Promise<void> {
  const paths = await findPackageJsons()
  const publishable = await findPublishable()

  const problems: string[] = []
  for (const path of paths) {
    const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, path), "utf-8")) as { name: string; private?: boolean }
    if (pkg.private === true) continue
    if (!publishable.has(path)) {
      problems.push(`${path} (${pkg.name}) is publishable but publish-npm.yml cannot ship it — add "private": true`)
    } else if (!pkg.name.startsWith(SCOPE)) {
      problems.push(`${path} (${pkg.name}) publishes under a scope we do not own — rename it to ${SCOPE}*`)
    }
  }

  if (problems.length > 0) {
    console.error("\n❌ package.json publishing problems:")
    for (const problem of problems) console.error(`   ${problem}`)
    process.exit(1)
  }
  console.log(`✓ ${paths.length} packages: ${publishable.size} publishable under ${SCOPE}, rest private`)
}

main().catch((err) => {
  console.error("check-package-scopes failed:", err)
  process.exit(1)
})
