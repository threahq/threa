#!/usr/bin/env bun
/**
 * Lint: every Bun monorepo workspace `package.json` must be COPY-ed into
 * each Dockerfile that runs `bun install --frozen-lockfile`. If a new
 * workspace lands without a corresponding COPY line, the next Railway
 * build dies inside the container with:
 *
 *   error: lockfile had changes, but lockfile is frozen
 *
 * because bun sees a workspace in the lockfile that doesn't exist on
 * disk in the build context, tries to mutate the lockfile to drop it,
 * and fails on `--frozen-lockfile`. See PR #338 for the incident.
 *
 * Run via `bun scripts/check-dockerfile-workspaces.ts` (also wired into
 * the root `lint` script and the CI lint job).
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")

async function findWorkspacePackageJsons(): Promise<string[]> {
  const result: string[] = []
  for (const root of ["apps", "packages"]) {
    const glob = new Bun.Glob(`${root}/*/package.json`)
    for await (const path of glob.scan({ cwd: REPO_ROOT })) {
      result.push(path)
    }
  }
  return result.sort()
}

async function findDockerfilesNeedingChecks(): Promise<string[]> {
  const result: string[] = []
  const glob = new Bun.Glob("Dockerfile*")
  for await (const path of glob.scan({ cwd: REPO_ROOT })) {
    const content = await readFile(resolve(REPO_ROOT, path), "utf-8")
    if (content.includes("bun install --frozen-lockfile")) {
      result.push(path)
    }
  }
  return result.sort()
}

// Matches `COPY apps/backend/package.json apps/backend/` style lines.
function extractCopiedWorkspaces(dockerfileContent: string): Set<string> {
  const result = new Set<string>()
  for (const line of dockerfileContent.split("\n")) {
    const match = line.match(/^COPY\s+(\S+)\/package\.json\s+\S+\s*$/)
    if (match) {
      result.add(`${match[1]}/package.json`)
    }
  }
  return result
}

async function main(): Promise<void> {
  const allWorkspaces = await findWorkspacePackageJsons()
  if (allWorkspaces.length === 0) {
    console.error("No workspace package.json files found — repo layout changed?")
    process.exit(1)
  }

  const dockerfiles = await findDockerfilesNeedingChecks()
  if (dockerfiles.length === 0) {
    console.log("No Dockerfiles run `bun install --frozen-lockfile`. Nothing to check.")
    return
  }

  let failed = false
  for (const dockerfile of dockerfiles) {
    const content = await readFile(resolve(REPO_ROOT, dockerfile), "utf-8")
    const copied = extractCopiedWorkspaces(content)
    const missing = allWorkspaces.filter((ws) => !copied.has(ws))
    if (missing.length > 0) {
      failed = true
      console.error(`\n❌ ${dockerfile} is missing workspace package.json COPY lines:`)
      for (const ws of missing) {
        const dir = ws.replace("/package.json", "/")
        console.error(`     COPY ${ws} ${dir}`)
      }
    } else {
      console.log(`✓ ${dockerfile} (${copied.size} workspace${copied.size === 1 ? "" : "s"})`)
    }
  }

  if (failed) {
    console.error(
      "\nWhen adding a new workspace under apps/ or packages/, add a corresponding COPY line\n" +
        "to each Dockerfile that runs `bun install --frozen-lockfile`. Bun's frozen lockfile\n" +
        "fails inside the container if any workspace listed in bun.lock is missing on disk.\n" +
        "See PR #338 and docs/deployment.md for the historical incident."
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("check-dockerfile-workspaces failed:", err)
  process.exit(1)
})
