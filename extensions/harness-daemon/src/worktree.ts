import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { canonicalOrRaw } from "./discovery"
import { die } from "./errors"
import { output, run } from "./shell"
import type { ManagedAgent, SpawnOptions } from "./types"

/**
 * Where {@link ensureWorktree} will put this agent, without creating anything —
 * and the single definition of that path, so a caller that has to name the
 * directory before it exists cannot drift from the one that creates it.
 *
 * The parent is canonicalized and the leaf appended, rather than canonicalizing
 * the whole path: the leaf does not exist yet, so `realpathSync` would throw and
 * fall back to the raw path — which then fails to match the resolved path every
 * later reader sees once the directory does exist.
 */
export function plannedWorktreePath(options: SpawnOptions): string {
  const repo = resolve(options.repo ?? process.cwd())
  return join(canonicalOrRaw(dirname(repo)), `threa.${options.name}`)
}

function branchFor(options: SpawnOptions): string {
  return options.branch ?? options.name
}

function baseFor(options: SpawnOptions): string {
  return options.base ?? "origin/main"
}

export function ensureWorktree(options: SpawnOptions): { worktree: string; branch: string } {
  const repo = resolve(options.repo ?? process.cwd())
  const branch = branchFor(options)
  const base = baseFor(options)
  const worktree = plannedWorktreePath(options)
  if (!existsSync(repo)) die(`repo not found: ${repo}`)
  if (existsSync(worktree)) die(`worktree dir already exists: ${worktree}`)

  console.log(`harnessd: fetching ${base} in ${repo}`)
  run(["git", "-C", repo, "fetch", "origin", base.replace(/^origin\//, "")])
  console.log(`harnessd: creating worktree ${worktree} (${branch} off ${base})`)
  run(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, base])
  maybeSetupWorktree(worktree, options.skipSetup === true)
  return { worktree, branch }
}

export function restorableWorktreeSource(
  agent: ManagedAgent
): { repo: string; worktree: string; branch: string } | { reason: string } {
  if (!agent.worktree) return { reason: "no worktree path recorded" }
  if (!agent.branch) return { reason: "no branch recorded" }
  const repoFlag = agent.command.indexOf("--repo")
  const repo = repoFlag >= 0 ? agent.command[repoFlag + 1] : undefined
  if (!repo) return { reason: "no source repo recorded" }
  if (!existsSync(repo)) return { reason: `source repo missing: ${repo}` }
  return { repo, worktree: agent.worktree, branch: agent.branch }
}

export function restoreManagedWorktree(agent: ManagedAgent): { restored: boolean; reason?: string } {
  if (agent.worktree && existsSync(agent.worktree)) return { restored: false }
  const source = restorableWorktreeSource(agent)
  if ("reason" in source) return { restored: false, reason: source.reason }

  output(["git", "-C", source.repo, "worktree", "prune"], { allowFailure: true })
  const result = output(["git", "-C", source.repo, "worktree", "add", source.worktree, source.branch], {
    allowFailure: true,
  })
  if (result.exitCode !== 0) {
    return { restored: false, reason: result.stderr.trim() || `could not restore ${source.branch}` }
  }
  maybeSetupWorktree(source.worktree, agent.command.includes("--skip-setup"))
  return { restored: true }
}

function maybeSetupWorktree(worktree: string, skipSetup: boolean): void {
  if (skipSetup) {
    console.warn("harnessd: --skip-setup: skipping bun run setup:worktree")
    return
  }
  const docker = output(["docker", "ps", "--format", "{{.Names}}"], { allowFailure: true })
  if (docker.exitCode !== 0 || !docker.stdout.split("\n").includes("threa-postgres")) {
    console.warn("harnessd: threa-postgres container not running; skipping setup:worktree")
    return
  }
  console.log("harnessd: running bun run setup:worktree")
  const result = run(["bun", "run", "setup:worktree"], { cwd: worktree, allowFailure: true })
  if (result.exitCode !== 0) console.warn("harnessd: setup:worktree reported errors; continuing")
}
