import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { die } from "./errors"
import { output, run } from "./shell"
import type { ManagedAgent, SpawnOptions } from "./types"

function repoWorktreeDir(repo: string, name: string): string {
  return resolve(dirname(resolve(repo)), `threa.${name}`)
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
  const worktree = repoWorktreeDir(repo, options.name)
  if (!existsSync(repo)) die(`repo not found: ${repo}`)
  if (existsSync(worktree)) die(`worktree dir already exists: ${worktree}`)

  console.log(`harnessd: fetching ${base} in ${repo}`)
  run(["git", "-C", repo, "fetch", "origin", base.replace(/^origin\//, "")])
  console.log(`harnessd: creating worktree ${worktree} (${branch} off ${base})`)
  run(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, base])
  maybeSetupWorktree(worktree, options.skipSetup === true)
  return { worktree, branch }
}

export function restoreManagedWorktree(agent: ManagedAgent): { restored: boolean; reason?: string } {
  if (agent.worktree && existsSync(agent.worktree)) return { restored: false }
  if (!agent.worktree) return { restored: false, reason: "no worktree path recorded" }
  if (!agent.branch) return { restored: false, reason: "no branch recorded" }
  const repoFlag = agent.command.indexOf("--repo")
  const repo = repoFlag >= 0 ? agent.command[repoFlag + 1] : undefined
  if (!repo) return { restored: false, reason: "no source repo recorded" }
  if (!existsSync(repo)) return { restored: false, reason: `source repo missing: ${repo}` }

  output(["git", "-C", repo, "worktree", "prune"], { allowFailure: true })
  const result = output(["git", "-C", repo, "worktree", "add", agent.worktree, agent.branch], { allowFailure: true })
  if (result.exitCode !== 0) {
    return { restored: false, reason: result.stderr.trim() || `could not restore ${agent.branch}` }
  }
  maybeSetupWorktree(agent.worktree, agent.command.includes("--skip-setup"))
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
